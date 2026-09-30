import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { coordinateProfileWriters, profileScope } from "../../src/kilocode/profile-maintenance"
import { profileSqlite } from "../../src/kilocode/profile-sqlite"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-sqlite-admission-"))
  await mkdir(path.join(dir, "storage"))
  const file = path.join(dir, "kilo.db")
  return {
    dir,
    file,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
async function wait(file: string) {
  const stop = performance.now() + 5_000
  while (!(await Bun.file(file).exists())) {
    if (performance.now() >= stop) throw new Error("Fixture did not reach its real SQLite operation")
    await Bun.sleep(10)
  }
}
for (const mode of ["legacy-transaction", "effect-transaction", "effect-managed", "legacy-iterator", "effect-iterator"])
  test(`maintenance drains actual ${mode} adapter and excludes raw prepared statements`, async () => {
    await using tmp = await fixture()
    const input = { file: tmp.file, ready: path.join(tmp.dir, "ready"), release: path.join(tmp.dir, "release"), mode }
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "profile-sqlite-worker.ts"), JSON.stringify(input)],
      { stdout: "pipe", stderr: "pipe" },
    )
    try {
      await wait(input.ready)
      const peer = profileSqlite(tmp.file, () => new Database(tmp.file))
      // An ordinary independent transaction does not exclude other native clients or readers.
      expect(peer.query("SELECT COUNT(*) AS total FROM fixture").get()).toBeTruthy()
      const statement = peer.query("INSERT INTO fixture VALUES ('forbidden')")
      const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
      let entered = false
      const maintenance = coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
        entered = true
        expect(() => statement.run()).toThrow("maintenance excludes")
        expect(() => profileSqlite(tmp.file, () => new Database(tmp.file))).toThrow("maintenance excludes")
        const snapshot = new Database(tmp.file, { readonly: true })
        expect(snapshot.query("SELECT value FROM fixture").all().length).toBe(mode.endsWith("iterator") ? 1 : 2)
        snapshot.close()
      })
      await Bun.sleep(50)
      expect(entered).toBe(false)
      await writeFile(input.release, "release")
      const status = await child.exited
      const errors = await new Response(child.stderr).text()
      expect(errors).toBe("")
      expect(status).toBe(0)
      await maintenance
      statement.run()
      peer.close()
    } finally {
      child.kill()
      await child.exited
    }
  })

test("Bun callback transactions and savepoints retain admission and release on rollback", async () => {
  await using tmp = await fixture()
  const db = profileSqlite(tmp.file, () => new Database(tmp.file))
  db.run("CREATE TABLE fixture(value TEXT)")
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  const transaction = db.transaction(() => {
    db.transaction(() => db.run("INSERT INTO fixture VALUES ('nested')"))()
    throw new Error("rollback")
  })
  expect(() => transaction.immediate()).toThrow("rollback")
  expect(db.inTransaction).toBe(false)
  await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    expect(() => db.query("SELECT * FROM fixture").all()).toThrow("maintenance excludes")
  })
  expect(db.query("SELECT * FROM fixture").all()).toEqual([])
  db.close()
})

test("real Node native legacy and Effect adapters drain transactions and prepared iterators", async () => {
  await using tmp = await fixture()
  const bundle = path.join(tmp.dir, "node-worker.mjs")
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "profile-sqlite-node-worker.ts")],
    target: "node",
    format: "esm",
  })
  expect(built.success).toBe(true)
  await Bun.write(bundle, built.outputs[0]!)
  for (const mode of ["legacy-transaction", "effect-managed", "legacy-iterator", "effect-iterator"]) {
    const file = path.join(tmp.dir, `${mode}.db`)
    const input = {
      file,
      ready: path.join(tmp.dir, `${mode}-ready`),
      release: path.join(tmp.dir, `${mode}-release`),
      mode,
    }
    const child = Bun.spawn(["node", bundle, JSON.stringify(input)], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    })
    try {
      await wait(input.ready)
      const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, override: file })
      let entered = false
      const maintenance = coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
        entered = true
        const db = new Database(file, { readonly: true })
        expect(db.query("SELECT * FROM fixture").all().length).toBe(mode.endsWith("iterator") ? 1 : 2)
        db.close()
      })
      await Bun.sleep(40)
      expect(entered).toBe(false)
      await writeFile(input.release, "release")
      const status = await child.exited
      expect(await new Response(child.stderr).text()).toBe("")
      expect(status).toBe(0)
      await maintenance
    } finally {
      child.kill()
      await child.exited
    }
  }
}, 20_000)

test("active SQLite publication races never write inside maintenance and peers retain WAL admission", async () => {
  await using tmp = await fixture()
  const input = {
    file: tmp.file,
    ready: path.join(tmp.dir, "ready"),
    release: path.join(tmp.dir, "release"),
    mode: "legacy-stress",
  }
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "profile-sqlite-worker.ts"), JSON.stringify(input)],
    { stdout: "pipe", stderr: "pipe" },
  )
  try {
    await wait(input.ready)
    const peer = profileSqlite(tmp.file, () => new Database(tmp.file))
    peer.run("INSERT INTO fixture VALUES ('peer')")
    const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
    for (let index = 0; index < 4; index++)
      await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
        const db = new Database(tmp.file, { readonly: true })
        const count = () => db.query("SELECT COUNT(*) AS total FROM fixture").get()
        const before = count()
        await Bun.sleep(30)
        expect(count()).toEqual(before)
        db.close()
      })
    await writeFile(input.release, "release")
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    peer.close()
  } finally {
    child.kill()
    await child.exited
  }
})

test("a crashed native transaction marker is recovered only after its independent owner exits", async () => {
  await using tmp = await fixture()
  const input = {
    file: tmp.file,
    ready: path.join(tmp.dir, "ready"),
    release: path.join(tmp.dir, "release"),
    mode: "legacy-transaction",
  }
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "profile-sqlite-worker.ts"), JSON.stringify(input)],
    { stdout: "pipe", stderr: "pipe" },
  )
  try {
    await wait(input.ready)
    child.kill()
    await child.exited
    const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
    let entered = false
    await coordinateProfileWriters(
      scope,
      "cooperative-maintenance",
      async () => {
        entered = true
      },
      { timeoutMs: 500 },
    )
    expect(entered).toBe(true)
  } finally {
    child.kill()
    await child.exited
  }
})
