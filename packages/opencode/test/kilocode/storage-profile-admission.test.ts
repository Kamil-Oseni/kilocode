import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { coordinateProfileWriters, profileScope } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Effect, Exit, Fiber } from "effect"
import { storageAdmission } from "@/kilocode/migration/storage-admission"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"

async function wait(file: string) {
  const deadline = performance.now() + 12000
  while (!(await Bun.file(file).exists())) {
    if (performance.now() > deadline) throw new Error("Actual Storage worker deadline elapsed")
    await Bun.sleep(10)
  }
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-storage-process-"))
  await mkdir(path.join(dir, "storage"))
  const children: Bun.Subprocess[] = []
  return {
    dir,
    children,
    async [Symbol.asyncDispose]() {
      for (const child of children) {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}
function worker(tmp: Awaited<ReturnType<typeof fixture>>, name: string, held = false) {
  const input = {
    dir: path.join(tmp.dir, "storage"),
    start: path.join(tmp.dir, `${name}-start`),
    ready: path.join(tmp.dir, `${name}-ready`),
    done: path.join(tmp.dir, `${name}-done`),
    ...(held ? { release: path.join(tmp.dir, `${name}-release`) } : {}),
  }
  const home = path.join(tmp.dir, name)
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "storage-profile-worker.ts"), JSON.stringify(input)],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        KILO_TEST_HOME: home,
        HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
      },
    },
  )
  tmp.children.push(child)
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  return {
    ...input,
    child,
    stderr,
    stdout,
    async joined() {
      const code = await child.exited
      const text = await stderr
      await stdout
      expect(text).not.toContain("error:")
      expect(code).toBe(0)
    },
  }
}

test("maintenance waits for an actual independent Storage write, then blocks another real writer", async () => {
  await using tmp = await fixture()
  const first = worker(tmp, "first", true)
  await Promise.race([
    wait(first.ready),
    first.child.exited.then(async () => {
      throw new Error(await first.stderr)
    }),
  ])
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  let entered = false
  const pending = coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    entered = true
    expect(await Bun.file(path.join(tmp.dir, "storage", "actual.json")).json()).toEqual({ value: "settled" })
    const second = worker(tmp, "second")
    await wait(second.start)
    await Bun.sleep(100)
    expect(await Bun.file(second.ready).exists()).toBe(false)
    return second
  })
  await Bun.sleep(100)
  expect(entered).toBe(false)
  await writeFile(first.release!, "release")
  await first.joined()
  const second = (await pending).value
  await wait(second.done)
  await second.joined()
}, 30000)

test("same-fiber nested JSON admission is reentrant and inherited child admission fails closed", async () => {
  await using tmp = await fixture()
  const gate = storageAdmission(path.join(tmp.dir, "storage"), ProfileWriterLive.storage)
  expect(await Effect.runPromise(gate.run(gate.run(Effect.succeed("settled"))))).toBe("settled")
  const result = await Effect.runPromise(
    gate.run(gate.run(Effect.void).pipe(Effect.forkChild({ startImmediately: true }), Effect.flatMap(Fiber.await))),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(await Effect.runPromise(gate.run(Effect.succeed("released")))).toBe("released")
})

test("maintenance blocks first-use JSON migration and marker publication in an independent process", async () => {
  await using tmp = await fixture()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  const pending = await coordinateProfileWriters(scope, "cooperative-maintenance", async () => {
    const child = worker(tmp, "fresh")
    await wait(child.start)
    await Bun.sleep(100)
    expect(await Bun.file(path.join(tmp.dir, "storage", "migration")).exists()).toBe(false)
    expect(await Bun.file(child.ready).exists()).toBe(false)
    return child
  })
  await wait(pending.value.done)
  await pending.value.joined()
  expect(await Bun.file(path.join(tmp.dir, "storage", "migration")).text()).toBe("2")
}, 30000)

test("interrupting a JSON owner retains exclusion until its native write settles", async () => {
  await using tmp = await fixture()
  const gate = storageAdmission(path.join(tmp.dir, "storage"), ProfileWriterLive.storage)
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const file = path.join(tmp.dir, "storage", "settlement.json")
  const fiber = Effect.runFork(
    gate.run(
      Effect.promise(async () => {
        ready.resolve()
        await release.promise
        await Bun.write(file, JSON.stringify({ settled: true }))
      }),
    ),
  )
  try {
    await ready.promise
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    let entered = false
    const result = await coordinateProfileWriters(
      scope,
      "cooperative-maintenance",
      async () => {
        entered = true
        return "unexpected"
      },
      {
        timeoutMs: 100,
      },
    ).then(
      () => "unexpected",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(entered).toBe(false)
    expect(result).toMatch(
      /Timed out|Profile maintenance admission deadline elapsed|Profile maintenance timed out draining active profile operations/,
    )
    release.resolve()
    await interrupted
    expect(await Bun.file(file).json()).toEqual({ settled: true })
    expect((await coordinateProfileWriters(scope, "cooperative-maintenance", async () => "released")).value).toBe(
      "released",
    )
  } finally {
    release.resolve()
    await Effect.runPromise(Fiber.interrupt(fiber))
  }
})

test("a crashed independent JSON writer cannot strand ordinary writes or maintenance", async () => {
  await using tmp = await fixture()
  const dead = worker(tmp, "dead", true)
  await Promise.race([
    wait(dead.ready),
    dead.child.exited.then(async () => {
      throw new Error(await dead.stderr)
    }),
  ])
  dead.child.kill("SIGKILL")
  await dead.child.exited
  await Promise.all([dead.stdout, dead.stderr])
  const absent = (() => {
    try {
      process.kill(dead.child.pid, 0)
      return false
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") return true
      throw err
    }
  })()
  expect(absent).toBe(true)
  const next = worker(tmp, "next")
  await wait(next.done)
  await next.joined()
  const scope = await profileScope({ data: tmp.dir, channel: "latest", disabled: false })
  const result = await coordinateProfileWriters(
    scope,
    "cooperative-maintenance",
    async () => await Bun.file(path.join(tmp.dir, "storage", "actual.json")).json(),
  )
  expect(result.value).toEqual({ value: "settled" })
}, 30000)

test("actual Storage first-use creates deep missing ancestors under canonical participant admission", async () => {
  await using tmp = await fixture()
  const dir = path.join(tmp.dir, "a", "b", "storage")
  expect(existsSync(path.join(tmp.dir, "a"))).toBe(false)
  const value = await Effect.runPromise(
    Storage.Service.use((store) =>
      store.write(["nested"], { value: "settled" }).pipe(Effect.andThen(store.read<{ value: string }>(["nested"]))),
    ).pipe(
      Effect.provide(Storage.layerFromDir(dir)),
      Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
    ),
  )
  expect(value).toEqual({ value: "settled" })
  expect(await Bun.file(path.join(dir, "migration")).text()).toBe("2")
  const scope = await profileScope({ data: tmp.dir, storage: dir, channel: "latest", disabled: false })
  const result = await coordinateProfileWriters(
    scope,
    "cooperative-maintenance",
    async () => await Bun.file(path.join(dir, "nested.json")).json(),
  )
  expect(result.value).toEqual({ value: "settled" })
})
