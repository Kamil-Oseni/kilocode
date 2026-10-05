import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import sync from "node:fs"
import { Effect } from "effect"
import { ModelOwner } from "../../src/kilocode/config/model-owner"
import { ProfileWriterRegistry } from "../../src/kilocode/migration/writer-registry"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { coordinateProfileWriters } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Flock } from "@opencode-ai/core/util/flock"
import { tmpdir } from "../fixture/fixture"

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

test("reserved producers span scheduling, gates and generation retirement", async () => {
  await using tmp = await tmpdir()
  const registry = ProfileWriterRegistry.make(["profile.state.model"])
  Effect.runSync(registry.register("profile.state.model"))
  const owner = ModelOwner.make({
    publish: () => undefined,
    activate: () => ProfileWriterLive.from(registry, "profile.state.model"),
  })
  const group = owner.group()
  const start = signal()
  const release = signal()
  const entered = signal()
  const held = coordinateProfileWriters(
    {
      version: 1,
      id: "model-real-gate",
      roots: [
        { kind: "json", path: path.join(tmp.path, "model.json") },
        { kind: "sqlite", path: path.join(tmp.path, "unused.db") },
      ],
    },
    "cooperative-maintenance",
    async () => {
      entered.resolve()
      await release.promise
    },
  )
  await entered.promise
  const work = group.launch(tmp.path, async (ticket) => {
    await start.promise
    return Effect.runPromise(
      owner.effect(
        ticket,
        owner.update((data) => ({ ...data, favorite: ["actual"] })),
      ),
    )
  })
  expect(owner.snapshot().active).toBe(1)
  expect(Effect.runSync(registry.snapshot).active).toEqual([{ id: "profile.state.model", count: 1 }])
  let settled = false
  const drain = group.settle().then(() => {
    settled = true
  })
  await Promise.resolve(expect(group.launch(tmp.path, () => Promise.resolve())).rejects.toThrow("retired"))
  start.resolve()
  await Bun.sleep(50)
  expect(settled).toBe(false)
  expect(await Bun.file(path.join(tmp.path, "model.json")).exists()).toBe(false)
  release.resolve()
  await held
  await work
  await drain
  expect(await Bun.file(path.join(tmp.path, "model.json")).json()).toEqual({ favorite: ["actual"] })
  expect(owner.snapshot().active).toBe(0)
  expect(Effect.runSync(registry.snapshot).active).toEqual([])
  await owner.drain()
})

test("matching extension lock preserves concurrent fields and unknown data", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await fs.writeFile(file, JSON.stringify({ retained: { exact: true }, favorite: [], variant: {} }))
  const owner = ModelOwner.make({ publish: () => undefined })
  const lock = await Flock.acquire(`raya.model-state:${process.platform === "win32" ? file.toLowerCase() : file}`, {
    dir: path.join(tmp.path, ".raya-model-locks"),
  })
  const first = owner.change(tmp.path, (data) => ({ ...data, favorite: ["one"] }))
  const second = owner.change(tmp.path, (data) => ({ ...data, variant: { actual: "none" } }))
  await Bun.sleep(80)
  expect(await Bun.file(file).json()).toEqual({ retained: { exact: true }, favorite: [], variant: {} })
  await lock.release()
  await Promise.all([first, second])
  expect(await Bun.file(file).json()).toEqual({
    retained: { exact: true },
    favorite: ["one"],
    variant: { actual: "none" },
  })
  await owner.drain()
})

test("failed scheduling settles without claiming persistence", async () => {
  await using tmp = await tmpdir()
  const owner = ModelOwner.make({ publish: () => undefined })
  const original = new Error("actual scheduler refused")
  await Promise.resolve(
    expect(
      owner.group().launch(tmp.path, () => {
        throw original
      }),
    ).rejects.toBe(original),
  )
  expect(owner.snapshot()).toEqual({ closed: false, active: 0, failures: 0 })
  expect(await Bun.file(path.join(tmp.path, "model.json")).exists()).toBe(false)
  await owner.drain()
})

test("runtime retirement joins accepted lazy initialization before disposal", async () => {
  await using tmp = await tmpdir()
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      path.join(import.meta.dir, "fixtures/model-owner-process.ts"),
      "runtime",
      tmp.path,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        XDG_STATE_HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(errors).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(output)).toEqual({ passed: true, events: ["dispose"], active: 0 })
}, 15_000)

test("separate extension-compatible lock owner retains its generation", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await fs.writeFile(file, JSON.stringify({ retained: "original", favorite: [] }))
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      path.join(import.meta.dir, "fixtures/model-owner-process.ts"),
      "lock",
      tmp.path,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_STATE_HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      },
    },
  )
  const reader = child.stdout.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value).trim()).toBe("ready")
  const owner = ModelOwner.make({ publish: () => undefined })
  const work = owner.change(tmp.path, (data) => ({ ...data, favorite: ["changed"] }))
  await Bun.sleep(80)
  expect(await Bun.file(file).json()).toEqual({ retained: "original", favorite: [] })
  await Promise.resolve(child.stdin.write("release\n"))
  await Promise.resolve(child.stdin.end())
  await work
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stderr).text()).toBe("")
  expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("released")
  reader.releaseLock()
  expect(await Bun.file(file).json()).toEqual({ retained: "original", favorite: ["changed"] })
  await owner.drain()
}, 15_000)

test("foreign predecessor replacement is preserved and retirement remains failed", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await fs.writeFile(file, JSON.stringify({ original: true }))
  const owner = ModelOwner.make({ publish: () => undefined })
  await Promise.resolve(
    expect(
      owner.change(tmp.path, (data) => {
        sync.renameSync(file, path.join(tmp.path, "original.json"))
        sync.writeFileSync(file, JSON.stringify({ foreign: true }))
        return { ...data, favorite: [] }
      }),
    ).rejects.toThrow("predecessor changed"),
  )
  expect(await Bun.file(file).json()).toEqual({ foreign: true })
  expect(await Bun.file(path.join(tmp.path, "original.json")).json()).toEqual({ original: true })
  expect(owner.snapshot().active).toBe(0)
  await Promise.resolve(expect(owner.drain()).rejects.toThrow("predecessor changed"))
})

test("actual body and lock cleanup failures retain both original causes", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await fs.writeFile(file, JSON.stringify({ original: true }))
  const owner = ModelOwner.make({ publish: () => undefined })
  const original = new Error("actual model callback failed")
  const err = await owner
    .change(tmp.path, () => {
      const root = path.join(tmp.path, ".raya-model-locks")
      const dirs = sync.readdirSync(root).filter((name) => name.endsWith(".lock"))
      expect(dirs).toHaveLength(1)
      sync.writeFileSync(path.join(root, dirs[0], "meta.json"), "{}")
      throw original
    })
    .then(
      () => undefined,
      (err: unknown) => err,
    )
  expect(err).toBeInstanceOf(AggregateError)
  if (!(err instanceof AggregateError)) throw err
  expect(err.errors).toContain(original)
  expect(err.errors.some((error) => error instanceof Error && error.message.includes("token mismatch"))).toBe(true)
  expect(await Bun.file(file).json()).toEqual({ original: true })
  await Promise.resolve(expect(owner.drain()).rejects.toBe(err))
})

test("pre-admission unsafe namespace refusal does not poison shutdown", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "unsafe")
  await fs.writeFile(file, "actual regular file")
  const owner = ModelOwner.make({ publish: () => undefined })
  await Promise.resolve(expect(owner.change(file, () => ({ favorite: [] }))).rejects.toThrow("parent identity"))
  expect(owner.snapshot()).toEqual({ closed: false, active: 0, failures: 0 })
  expect(await Bun.file(file).text()).toBe("actual regular file")
  await owner.drain()
})

test("namespace replacement refuses publication and preserves the foreign directory", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "state")
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, "model.json"), "{}")
  const owner = ModelOwner.make({ publish: () => undefined })
  await Promise.resolve(
    expect(
      owner.change(root, () => {
        sync.renameSync(root, path.join(tmp.path, "retained"))
        sync.mkdirSync(root)
        sync.writeFileSync(path.join(root, "foreign.txt"), "retained")
        return { favorite: [] }
      }),
    ).rejects.toBeInstanceOf(AggregateError),
  )
  expect(await Bun.file(path.join(root, "foreign.txt")).text()).toBe("retained")
  expect(await Bun.file(path.join(root, "model.json")).exists()).toBe(false)
  expect(owner.snapshot().active).toBe(0)
  await Promise.resolve(expect(owner.drain()).rejects.toBeInstanceOf(AggregateError))
})

test("interruption joins an accepted atomic write and its finalizers", async () => {
  await using tmp = await tmpdir()
  const owner = ModelOwner.make({ publish: () => undefined })
  const ready = signal()
  const release = signal()
  const gate = coordinateProfileWriters(
    {
      version: 1,
      id: "model-interruption",
      roots: [
        { kind: "json", path: path.join(tmp.path, "model.json") },
        { kind: "sqlite", path: path.join(tmp.path, "unused.db") },
      ],
    },
    "cooperative-maintenance",
    async () => {
      ready.resolve()
      await release.promise
    },
  )
  await ready.promise
  const controller = new AbortController()
  const work = owner.group().launch(tmp.path, (ticket) =>
    Effect.runPromise(
      owner.effect(
        ticket,
        owner.update((data) => ({ ...data, variant: { genuine: "none" } })),
      ),
      { signal: controller.signal },
    ),
  )
  const result = work.then(
    () => undefined,
    (err: unknown) => err,
  )
  await Bun.sleep(50)
  controller.abort()
  let settled = false
  const drain = owner.drain().then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await Bun.sleep(50)
  expect(owner.snapshot().active).toBe(1)
  expect(settled).toBe(false)
  release.resolve()
  await gate
  expect(await result).toBeInstanceOf(Error)
  await drain
  expect(owner.snapshot().active).toBe(0)
  expect(await Bun.file(path.join(tmp.path, "model.json")).json()).toEqual({ variant: { genuine: "none" } })
  expect(owner.snapshot().failures).toBe(1)
})

test("Effect scheduling retains the sole original publication error", async () => {
  await using tmp = await tmpdir()
  const owner = ModelOwner.make({ publish: () => undefined })
  const original = new Error("actual publication failed")
  const work = owner.group().launch(tmp.path, (ticket) =>
    owner.result(
      Effect.runPromiseExit(
        owner.effect(
          ticket,
          owner.update(() => {
            throw original
          }),
        ),
      ),
    ),
  )
  await Promise.resolve(expect(work).rejects.toBe(original))
  expect(owner.snapshot().active).toBe(0)
  await Promise.resolve(expect(owner.drain()).rejects.toBe(original))
})

test("absent state creation respects the genuine enclosing gate", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "state")
  const ready = signal()
  const release = signal()
  const gate = coordinateProfileWriters(
    {
      version: 1,
      id: "model-parent",
      roots: [
        { kind: "json", path: tmp.path },
        { kind: "sqlite", path: path.join(tmp.path, "unused.db") },
      ],
    },
    "cooperative-maintenance",
    async () => {
      ready.resolve()
      await release.promise
    },
  )
  await ready.promise
  const owner = ModelOwner.make({ publish: () => undefined })
  const work = owner.change(root, () => ({ favorite: [] }))
  await Bun.sleep(50)
  expect(
    await fs.stat(root).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(owner.snapshot().active).toBe(1)
  release.resolve()
  await gate
  await work
  expect(await Bun.file(path.join(root, "model.json")).json()).toEqual({ favorite: [] })
  await owner.drain()
})
