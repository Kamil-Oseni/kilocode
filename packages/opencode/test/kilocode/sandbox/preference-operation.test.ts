import { expect, test as check } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { Deferred, Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { coordinateProfileWriters, profileScope } from "@opencode-ai/core/kilocode/profile-maintenance"
import { jsonOperation } from "@/kilocode/migration/json-operation"

const profiles = new AsyncLocalStorage<string[]>()
function test(name: string, body: () => Promise<void>, timeout?: number) {
  check(
    name,
    () =>
      profiles.run([], async () => {
        const dirs = profiles.getStore()!
        try {
          await body()
        } catch (err) {
          for (const dir of dirs) {
            await fs.writeFile(path.join(dir, "failure.txt"), String(err))
            console.error(`Retained preference test profile: ${dir}`)
          }
          throw err
        }
        for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
      }),
    timeout,
  )
}

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raya-preference-operation-"))
  profiles.getStore()?.push(dir)
  const base = path.join(dir, "selected")
  await fs.mkdir(base)
  return {
    dir,
    base,
    root: path.join(base, "kilo-sandbox-preference"),
  }
}
async function wait(file: string) {
  const deadline = performance.now() + 10_000
  while (!(await Bun.file(file).exists())) {
    if (performance.now() >= deadline) throw new Error("Preference fixture readiness timed out")
    await Bun.sleep(10)
  }
}
function child(dir: string, base: string, mode: string) {
  const process = Bun.spawn(
    [
      globalThis.process.execPath,
      path.join(import.meta.dir, "../fixtures/preference-operation.ts"),
      JSON.stringify({ dir, base, mode }),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...globalThis.process.env,
        XDG_DATA_HOME: path.join(dir, "data"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_CACHE_HOME: path.join(dir, "cache"),
        XDG_STATE_HOME: path.join(dir, "state"),
        KILO_TEST_HOME: dir,
      },
    },
  )
  const stderr = new Response(process.stderr).text()
  const stdout = new Response(process.stdout).text()
  return {
    process,
    stderr,
    async [Symbol.asyncDispose]() {
      process.kill()
      const code = await process.exited
      await fs.writeFile(
        path.join(dir, `child-${process.pid}.json`),
        JSON.stringify({ mode, pid: process.pid, code, stdout: await stdout, stderr: await stderr }),
      )
    },
  }
}
const file = (root: string) => path.join(root, createHash("sha256").update("project").digest("hex") + ".json")

async function operations(root: string) {
  const dir = path.join(path.dirname(root), ".raya-profile-locks")
  const names = await fs.readdir(dir)
  return (
    await Promise.all(names.filter((name) => name.endsWith(".writers")).map((name) => fs.readdir(path.join(dir, name))))
  ).flat()
}

test("real independent sandbox preference writer cannot create files while canonical maintenance excludes it", async () => {
  const tmp = await fixture()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, storage: tmp.root })
  await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    await using worker = child(tmp.dir, tmp.base, "one")
    expect(await worker.process.exited).toBe(0)
    expect(await worker.stderr).toBe("")
    const result: unknown = await Bun.file(path.join(tmp.dir, "result.json")).json()
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).toContain("Timed out waiting")
    expect(await Bun.file(tmp.root).exists()).toBe(false)
    expect(await operations(tmp.root)).toEqual([])
  })
}, 15_000)

test("actual independent preference publications settle before maintenance and remain stable under both gates", async () => {
  const tmp = await fixture()
  await using worker = child(tmp.dir, tmp.base, "loop")
  await wait(path.join(tmp.dir, "count"))
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, storage: tmp.root })
  await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    const before = await fs.readFile(file(tmp.root), "utf8")
    expect(await operations(tmp.root)).toEqual([])
    const names = await fs.readdir(tmp.root)
    expect(names).toHaveLength(1)
    expect(JSON.parse(before)).toBeOneOf([true, false])
    await Bun.sleep(70)
    expect(await fs.readFile(file(tmp.root), "utf8")).toBe(before)
    expect(await fs.readdir(tmp.root)).toEqual(names)
    await fs.writeFile(path.join(tmp.dir, "release"), "release")
  })
  expect(await worker.process.exited).toBe(0)
  expect(await worker.stderr).toBe("")
  expect(await Bun.file(path.join(tmp.dir, "result.json")).json()).toMatchObject({ ok: true })
})

test("JSON bracket retains real native publication and cleanup after cancellation until they settle", async () => {
  const tmp = await fixture()
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, storage: tmp.root })
  const work = jsonOperation(
    () => tmp.root,
    async (root) => {
      await fs.mkdir(root)
      await fs.writeFile(path.join(root, "temporary"), "accepted")
      await Effect.runPromise(Deferred.succeed(entered, undefined))
      await Effect.runPromise(Deferred.await(release))
      await fs.rename(path.join(root, "temporary"), path.join(root, "published"))
      await fs.rm(path.join(root, "published"))
    },
  )
  const fiber = Effect.runFork(work)
  await Effect.runPromise(Deferred.await(entered))
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
  let called = false
  const gate = coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    called = true
    expect(await fs.readdir(tmp.root)).toEqual([])
    expect(await operations(tmp.root)).toEqual([])
  })
  await Bun.sleep(70)
  expect(called).toBe(false)
  expect(await fs.readFile(path.join(tmp.root, "temporary"), "utf8")).toBe("accepted")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await interrupted
  await gate
})

test("canonical JSON selection uses the resolved directory while a static alias targets that root", async () => {
  const tmp = await fixture()
  const alias = path.join(tmp.dir, "alias")
  await fs.symlink(tmp.base, alias, process.platform === "win32" ? "junction" : "dir")
  const selected = await Effect.runPromise(
    jsonOperation(
      () => path.join(alias, "preference"),
      async (root) => {
        await fs.mkdir(root)
        await fs.writeFile(path.join(root, "value"), "canonical")
        return root
      },
    ),
  )
  expect(selected).toBe(path.join(await fs.realpath(tmp.base), "preference"))
  expect(await fs.readFile(path.join(selected, "value"), "utf8")).toBe("canonical")
})

test("cancellation before root admission installs no native body or operation marker", async () => {
  const tmp = await fixture()
  let called = false
  const fiber = Effect.runFork(
    jsonOperation(
      () => tmp.root,
      async () => {
        called = true
      },
    ),
  )
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(called).toBe(false)
  expect(await Bun.file(tmp.root).exists()).toBe(false)
  expect(await Bun.file(path.join(tmp.base, ".raya-profile-locks")).exists()).toBe(false)
})

test("actual preference rename failure cleans its temporary file and permits a later explicit retry", async () => {
  const tmp = await fixture()
  await fs.mkdir(file(tmp.root), { recursive: true })
  await using failed = child(tmp.dir, tmp.base, "one")
  expect(await failed.process.exited).toBe(0)
  expect(await Bun.file(path.join(tmp.dir, "result.json")).json()).toMatchObject({ ok: false })
  expect(await fs.readdir(tmp.root)).toEqual([path.basename(file(tmp.root))])
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false, storage: tmp.root })
  await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    expect(await fs.readdir(tmp.root)).toEqual([path.basename(file(tmp.root))])
    expect(await operations(tmp.root)).toEqual([])
  })
  await fs.rmdir(file(tmp.root))
  await using retry = child(tmp.dir, tmp.base, "one")
  expect(await retry.process.exited).toBe(0)
  expect(await Bun.file(path.join(tmp.dir, "result.json")).json()).toMatchObject({ ok: true })
  expect(await fs.readFile(file(tmp.root), "utf8")).toBe("true")
})
