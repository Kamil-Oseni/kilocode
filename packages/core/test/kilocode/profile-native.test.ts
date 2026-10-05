import { expect, test as check } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { coordinateProfileNatives, profileScope } from "../../src/kilocode/profile-maintenance"
import { closeProfileSqlite, profileSqlite } from "../../src/kilocode/profile-sqlite"

const profiles = new AsyncLocalStorage<string[]>()
function test(name: string, body: () => Promise<void>) {
  check(name, () =>
    profiles.run([], async () => {
      const dirs = profiles.getStore()!
      try {
        await body()
      } catch (err) {
        for (const dir of dirs) {
          await writeFile(path.join(dir, "failure.txt"), String(err))
          console.error(`Retained native test profile: ${dir}`)
        }
        throw err
      }
      for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    }),
  )
}

async function refusal(body: Promise<unknown>, message?: string) {
  const result = await body.then(
    () => ({ ok: true, err: undefined }),
    (err: unknown) => ({ ok: false, err }),
  )
  expect(result.ok).toBe(false)
  expect(result.err).toBeInstanceOf(Error)
  if (message) expect(String(result.err)).toContain(message)
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-native-owners-"))
  profiles.getStore()?.push(dir)
  await mkdir(path.join(dir, "storage"))
  return {
    dir,
    file: path.join(dir, "kilo.db"),
  }
}
async function markers(dir: string, kind: string) {
  const root = path.join(dir, ".raya-profile-locks")
  const dirs = await readdir(root)
  const files = await Promise.all(
    dirs
      .filter((name) => name.endsWith(kind))
      .map(async (name) => {
        const folder = path.join(root, name)
        return (await readdir(folder)).map((name) => path.join(folder, name))
      }),
  )
  return files.flat()
}
async function child(dir: string, file: string, mode: string) {
  const ready = path.join(dir, "ready")
  const release = path.join(dir, "release")
  const process = Bun.spawn(
    [
      globalThis.process.execPath,
      path.join(import.meta.dir, "profile-native-worker.ts"),
      JSON.stringify({ file, mode, ready, release }),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const stdout = new Response(process.stdout).text()
  const stderr = new Response(process.stderr).text()
  const record = async () => {
    const code = await process.exited
    await writeFile(
      path.join(dir, "child.json"),
      JSON.stringify({ pid: process.pid, mode, code, stdout: await stdout, stderr: await stderr }),
    )
  }
  const deadline = performance.now() + 10_000
  while (!(await Bun.file(ready).exists())) {
    if (performance.now() >= deadline) {
      process.kill()
      await record()
      throw new Error(`Native child failed readiness: ${await stderr}`)
    }
    await Bun.sleep(10)
  }
  return {
    process,
    stderr,
    release,
    async [Symbol.asyncDispose]() {
      process.kill()
      await record()
    },
  }
}

test("canonical lifetime marker precedes actual native construction and survives until exact close", async () => {
  const tmp = await fixture()
  const db = profileSqlite(tmp.file, () => {
    expect(existsSync(tmp.file)).toBe(false)
    const dir = path.join(tmp.dir, ".raya-profile-locks")
    const owners = readdirSync(dir).filter((name) => name.endsWith(".owners"))
    expect(owners.flatMap((name) => readdirSync(path.join(dir, name))).length).toBe(1)
    return new Database(tmp.file)
  })
  expect((await markers(tmp.dir, ".owners")).length).toBe(1)
  db.close()
  expect(await markers(tmp.dir, ".owners")).toEqual([])
})

for (const mode of ["native", "legacy", "core", "graphs", "sequence", "export"])
  test(`idle independent ${mode} handle prevents a false zero-native receipt`, async () => {
    const tmp = await fixture()
    await using worker = await child(tmp.dir, tmp.file, mode)
    const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
    expect((await markers(tmp.dir, ".owners")).length).toBe(mode === "graphs" ? 2 : 1)
    expect(await markers(tmp.dir, ".writers")).toEqual([])
    let called = false
    await refusal(
      coordinateProfileNatives(scope, async () => {
        called = true
      }),
      "remain live",
    )
    expect(called).toBe(false)
    await writeFile(worker.release, "release")
    expect(await worker.process.exited).toBe(0)
    expect(await worker.stderr).toBe("")
    expect(await Bun.file(tmp.file + ".unused").exists()).toBe(false)
    const result = await coordinateProfileNatives(scope, async () => {
      expect(await markers(tmp.dir, ".owners")).toEqual([])
      expect(await markers(tmp.dir, ".writers")).toEqual([])
      return "zero"
    })
    expect(result).toMatchObject({
      value: "zero",
      admission: { nativeOwners: 0, operations: 0, cooperativeOnly: true, portableCaptureAuthorized: false },
    })
  })

test("premature gates drain a real transaction but refuse until its native owner actually retires", async () => {
  const tmp = await fixture()
  await using worker = await child(tmp.dir, tmp.file, "transaction")
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  expect((await markers(tmp.dir, ".writers")).length).toBe(1)
  let called = false
  const pending = coordinateProfileNatives(scope, async () => {
    called = true
  })
  const refused = refusal(pending, "remain live")
  await Bun.sleep(70)
  expect(called).toBe(false)
  await writeFile(worker.release, "release")
  await refused
  expect(await worker.process.exited).toBe(0)
  expect(await worker.stderr).toBe("")
  expect(called).toBe(false)
  const result = await coordinateProfileNatives(scope, async () => {
    expect(await markers(tmp.dir, ".owners")).toEqual([])
    expect(await markers(tmp.dir, ".writers")).toEqual([])
    using db = new Database(tmp.file, { readonly: true })
    return db.query("SELECT * FROM fixture").all()
  })
  expect(result.value).toEqual([{ value: "settled" }])
})

test("canonical alias opening and existing prepared statements remain excluded while zero-owner gates are held", async () => {
  const tmp = await fixture()
  const db = profileSqlite(tmp.file, () => new Database(tmp.file))
  db.run("CREATE TABLE fixture(value TEXT)")
  const stmt = db.query("SELECT * FROM fixture")
  db.close()
  const alias = path.join(tmp.dir, "alias")
  await symlink(tmp.dir, alias, process.platform === "win32" ? "junction" : "dir")
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  await coordinateProfileNatives(scope, async () => {
    let opened = false
    expect(() =>
      profileSqlite(path.join(alias, "kilo.db"), () => {
        opened = true
        return new Database(tmp.file)
      }),
    ).toThrow("maintenance excludes")
    expect(opened).toBe(false)
    expect(() => stmt.all()).toThrow("maintenance excludes")
    expect(await markers(tmp.dir, ".owners")).toEqual([])
    expect(await markers(tmp.dir, ".writers")).toEqual([])
  })
})

test("native ownership release failure and opaque opening failure retain lifetime refusal", async () => {
  const tmp = await fixture()
  const native = new Database(tmp.file)
  const db = profileSqlite(tmp.file, () => native)
  db.run("CREATE TABLE fixture(value TEXT)")
  const marker = (await markers(tmp.dir, ".owners"))[0]
  const record = await readFile(marker, "utf8")
  await writeFile(marker, "changed ownership")
  expect(() => db.close()).toThrow("changed native ownership")
  expect(() => native.query("SELECT * FROM fixture").all()).toThrow()
  expect((await markers(tmp.dir, ".owners")).length).toBe(1)
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  await refusal(coordinateProfileNatives(scope, async () => "unexpected"))
  await writeFile(marker, record)
  await closeProfileSqlite(db)
  await closeProfileSqlite(db)
  expect(await markers(tmp.dir, ".owners")).toEqual([])
  expect(() =>
    profileSqlite(tmp.file, () => {
      throw new Error("opening unproven")
    }),
  ).toThrow("opening unproven")
  expect((await markers(tmp.dir, ".owners")).length).toBe(1)
  await refusal(
    coordinateProfileNatives(scope, async () => "unexpected"),
    "remain live",
  )
})

test("crashed independent native owner is recovered only after its local PID is confirmed absent", async () => {
  const tmp = await fixture()
  await using worker = await child(tmp.dir, tmp.file, "native")
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  await refusal(
    coordinateProfileNatives(scope, async () => "unexpected"),
    "remain live",
  )
  worker.process.kill()
  await worker.process.exited
  expect(() => process.kill(worker.process.pid, 0)).toThrow()
  expect((await markers(tmp.dir, ".owners")).length).toBe(1)
  expect((await coordinateProfileNatives(scope, async () => "recovered")).value).toBe("recovered")
  expect(await markers(tmp.dir, ".owners")).toEqual([])
})

for (const mode of ["foreign", "malformed", "unknown", "live"])
  test(`uncertain ${mode} native ownership is never reclaimed`, async () => {
    const tmp = await fixture()
    await using worker = await child(tmp.dir, tmp.file, "native")
    worker.process.kill()
    await worker.process.exited
    const file = (await markers(tmp.dir, ".owners"))[0]
    const raw = Schema.decodeUnknownSync(
      Schema.Struct({
        format: Schema.String,
        version: Schema.Number,
        root: Schema.String,
        pid: Schema.Number,
        hostname: Schema.String,
        token: Schema.String,
      }),
    )(JSON.parse(await readFile(file, "utf8")))
    const record =
      mode === "malformed"
        ? "invalid"
        : JSON.stringify(
            mode === "foreign"
              ? { ...raw, hostname: "foreign" }
              : mode === "live"
                ? { ...raw, pid: process.pid }
                : { token: raw.token },
          )
    await writeFile(file, record)
    const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
    await refusal(coordinateProfileNatives(scope, async () => "unexpected"))
    expect(await readFile(file, "utf8")).toBe(record)
  })
