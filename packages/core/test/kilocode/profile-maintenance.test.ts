import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { admitProfileWriter, coordinateProfileWriters, profileScope } from "../../src/kilocode/profile-maintenance"
import { Flock } from "../../src/util/flock"
import { Database } from "bun:sqlite"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-maintenance-"))
  await mkdir(path.join(dir, "storage"))
  return {
    dir,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
async function wait(file: string) {
  const until = performance.now() + 5_000
  while (!(await Bun.file(file).exists())) {
    if (performance.now() > until) throw new Error("Fixture worker did not reach admission")
    await Bun.sleep(10)
  }
}
function child(dir: string, key?: string, writer?: "profile.sqlite.primary.effect") {
  const input = {
    data: dir,
    ready: path.join(dir, "ready"),
    release: path.join(dir, "release"),
    done: path.join(dir, "done"),
    key,
    dir: path.join(dir, "locks"),
    writer,
  }
  const process = Bun.spawn(
    [globalThis.process.execPath, path.join(import.meta.dir, "profile-maintenance-worker.ts"), JSON.stringify(input)],
    { stdout: "pipe", stderr: "pipe" },
  )
  return {
    input,
    process,
    async [Symbol.asyncDispose]() {
      process.kill()
      await process.exited
    },
  }
}

test("canonical roots include channel fallback, external database and JSON aliases without bootstrapping", async () => {
  await using tmp = await fixture()
  await writeFile(path.join(tmp.dir, "opencode-dev.db"), "")
  const input = { data: tmp.dir, channel: "dev", disabled: false }
  const scope = await profileScope(input)
  expect(scope.roots.find((root) => root.kind === "sqlite")!.path).toBe(
    await realpath(path.join(tmp.dir, "opencode-dev.db")),
  )
  const alias = path.join(tmp.dir, "alias")
  await symlink(path.join(tmp.dir, "storage"), alias, process.platform === "win32" ? "junction" : "dir")
  expect((await profileScope({ ...input, storage: alias })).id).toBe(scope.id)
  const external = path.join(tmp.dir, "external.db")
  expect((await profileScope({ ...input, override: external })).id).not.toBe(scope.id)
  await expect(profileScope({ ...input, override: ":memory:" })).rejects.toThrow("in-memory")
  expect(await Bun.file(path.join(tmp.dir, "kilo-dev.db")).exists()).toBe(false)
})

test("maintenance drains a real independent JSON writer and blocks new admitted writers", async () => {
  await using tmp = await fixture()
  await using worker = child(tmp.dir)
  await wait(worker.input.ready)
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  let entered = false
  const maintenance = coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    entered = true
    expect(await Bun.file(worker.input.done).text()).toBe("settled")
    await expect(
      admitProfileWriter(scope, "profile.sqlite.primary.legacy", async () => "unexpected", { timeoutMs: 50 }),
    ).rejects.toThrow("Timed out")
    return "captured"
  })
  await Bun.sleep(70)
  expect(entered).toBe(false)
  await writeFile(worker.input.release, "release")
  expect(await worker.process.exited).toBe(0)
  expect(await maintenance).toMatchObject({
    value: "captured",
    admission: { cooperativeOnly: true, completeProfileCoverage: false },
  })
})

test("cancellation retains exclusion until the admitted callback actually settles", async () => {
  await using tmp = await fixture()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  const controller = new AbortController()
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = coordinateProfileWriters(
    scope,
    "cooperative-maintenance",
    async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
    { signal: controller.signal },
  )
  const cancelled = pending.then(
    () => "unexpected",
    () => "cancelled",
  )
  await ready
  controller.abort()
  await expect(
    admitProfileWriter(scope, "profile.storage.json", async () => "unexpected", { timeoutMs: 50 }),
  ).rejects.toThrow("Timed out")
  release()
  expect(await cancelled).toBe("cancelled")
  expect(await admitProfileWriter(scope, "profile.storage.json", async () => "resumed")).toBe("resumed")
})

test("maintenance waits for a real independently admitted SQLite transaction to settle", async () => {
  await using tmp = await fixture()
  await using worker = child(tmp.dir, undefined, "profile.sqlite.primary.effect")
  await wait(worker.input.ready)
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  let entered = false
  const maintenance = coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    entered = true
    using db = new Database(path.join(tmp.dir, "kilo.db"), { readonly: true })
    return db.query("SELECT value FROM fixture").all()
  })
  await Bun.sleep(70)
  expect(entered).toBe(false)
  await writeFile(worker.input.release, "release")
  expect(await worker.process.exited).toBe(0)
  expect((await maintenance).value).toEqual([{ value: "settled" }])
})

test("portable capture intent refuses before running a callback under incomplete coverage", async () => {
  await using tmp = await fixture()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  let called = false
  expect(() =>
    coordinateProfileWriters(scope, "portable-capture", async () => {
      called = true
    }),
  ).toThrow("complete profile writer coverage")
  expect(called).toBe(false)
})

test("a suspended live independent owner is never reclaimed when recovery is disabled", async () => {
  await using tmp = await fixture()
  await using worker = child(tmp.dir, "suspended-live")
  await wait(worker.input.ready)
  await Bun.sleep(70)
  let entered = false
  await expect(
    Flock.withLock(
      worker.input.key!,
      async () => {
        entered = true
      },
      { dir: worker.input.dir, staleMs: 30, recover: false, timeoutMs: 120, baseDelayMs: 10, maxDelayMs: 10 },
    ),
  ).rejects.toThrow("Timed out")
  expect(entered).toBe(false)
  await writeFile(worker.input.release, "release")
  expect(await worker.process.exited).toBe(0)
  await Flock.withLock(
    worker.input.key!,
    async () => {
      entered = true
    },
    { dir: worker.input.dir, recover: false },
  )
  expect(entered).toBe(true)
})
