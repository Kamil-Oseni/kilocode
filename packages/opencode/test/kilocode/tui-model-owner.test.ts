import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Cause, Effect } from "effect"
import { make, scope } from "../../src/kilocode/cli/cmd/tui/model-state"
import { ModelOwner } from "../../src/kilocode/config/model-owner"
import { ProfileWriterRegistry } from "../../src/kilocode/migration/writer-registry"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { coordinateProfileWriters } from "@opencode-ai/core/kilocode/profile-maintenance"
import { make as projection, legacy, reduce } from "../../../tui/src/kilocode/model-state"
import { tmpdir } from "../fixture/fixture"

const first = { providerID: "local", modelID: "one" }
const second = { providerID: "local", modelID: "two" }

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

test("real gated TUI intents reserve before hydration, preserve concurrent fields, and join scope", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await fs.writeFile(
    file,
    JSON.stringify({
      model: { other: second },
      favorite: [second],
      variant: { other: "high" },
      unknown: { exact: true },
    }),
  )
  const registry = ProfileWriterRegistry.make(["profile.state.model"])
  Effect.runSync(registry.register("profile.state.model"))
  // Native namespace/file leases are genuine; the isolated owner does not publish process-lifetime ownership.
  const owner = ModelOwner.make({
    publish: () => undefined,
    activate: () => ProfileWriterLive.from(registry, "profile.state.model"),
  })
  const entered = signal()
  const release = signal()
  const held = coordinateProfileWriters(
    {
      version: 1,
      id: "tui-model-held",
      roots: [
        { kind: "json", path: file },
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
  let value: Record<string, unknown> = {}
  let ready = false
  let closed = false
  let port: ReturnType<typeof make> | undefined
  const running = Effect.runPromise(
    scope(
      tmp.path,
      (current) =>
        Effect.sync(() => {
          port = current
          const model = projection(
            current,
            (data) => {
              value = data
            },
            () => {
              ready = true
            },
          )
          model.change({ kind: "pick", agent: "code", model: first, recent: first })
          model.change({ kind: "favorite", model: first })
          model.change({ kind: "favorite", model: first })
          model.change({ kind: "variant", key: "local/one", value: "default" })
          expect(ready).toBe(false)
          expect(owner.snapshot().active).toBe(4)
        }),
      owner,
    ),
  ).then(() => {
    closed = true
  })
  await Bun.sleep(60)
  expect(closed).toBe(false)
  expect(owner.snapshot().active).toBe(4)
  expect(Effect.runSync(registry.snapshot).active).toEqual([{ id: "profile.state.model", count: 4 }])
  // A cooperating external publisher changes the latest generation while TUI is waiting.
  await fs.writeFile(
    file,
    JSON.stringify({
      model: { other: second },
      favorite: [second],
      variant: { other: "high" },
      unknown: { exact: true },
      external: "retained",
    }),
  )
  release.resolve()
  await held
  await running
  const data = JSON.parse(await fs.readFile(file, "utf8"))
  expect(data).toEqual({
    model: { other: second, code: first },
    favorite: [second],
    variant: { other: "high", "local/one": "default" },
    unknown: { exact: true },
    external: "retained",
    recent: [first],
  })
  expect(value).toEqual(data)
  expect(owner.snapshot().active).toBe(0)
  expect(Effect.runSync(registry.snapshot).active).toEqual([])
  expect(() => port!.change((data) => data)).toThrow("retired")
  await owner.drain()
})

test("actual TUI scope preserves body and publication failures and refuses late intake", async () => {
  await using tmp = await tmpdir()
  const owner = ModelOwner.make({ publish: () => undefined })
  const original = new Error("TUI body failure")
  const mutation = new Error("Actual admitted reducer failure")
  const exit = await Effect.runPromiseExit(
    scope(
      tmp.path,
      (port) =>
        Effect.gen(function* () {
          const job = port.change(() => {
            throw mutation
          })
          yield* Effect.promise(() =>
            job.catch((err) => {
              expect(err).toBe(mutation)
            }),
          )
          return yield* Effect.fail(original)
        }),
      owner,
    ),
  )
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("Expected actual scope failure")
  const failures = Cause.squash(exit.cause)
  expect(failures).toBeInstanceOf(AggregateError)
  if (!(failures instanceof AggregateError)) throw new Error("Expected aggregate causes")
  expect(failures.errors).toContain(original)
  expect(failures.errors).toContain(mutation)
  expect(owner.snapshot().active).toBe(0)
  expect(owner.snapshot().failures).toBe(1)
  await Promise.resolve(expect(owner.drain()).rejects.toBe(mutation))
})

test("real read failure is not an empty-state success, and unused scope does not realize model owner", async () => {
  await using tmp = await tmpdir()
  const owner = ModelOwner.make({ publish: () => undefined })
  await Effect.runPromise(scope(tmp.path, () => Effect.void, owner))
  expect(owner.snapshot()).toEqual({ closed: false, active: 0, failures: 0 })
  await fs.mkdir(path.join(tmp.path, "model.json"))
  const port = make(tmp.path, owner)
  const err = await port.read().then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(err).toBeInstanceOf(Error)
  await Promise.resolve(expect(port.settle()).rejects.toBe(err))
  expect(() => port.read()).toThrow("retired")
  await owner.drain()
})

test("standalone actual files preserve sentinel, unknown nested keys, toggle parity and recent limit", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await fs.writeFile(
    file,
    JSON.stringify({
      unknown: true,
      model: { keep: second, configured: first },
      variant: { keep: "none" },
      recent: Array.from({ length: 12 }, (_, id) => ({ providerID: "local", modelID: String(id) })),
    }),
  )
  const port = legacy(
    () => fs.readFile(file, "utf8").then(JSON.parse),
    (data) => fs.writeFile(file, JSON.stringify(data)),
  )
  const model = projection(
    port,
    () => undefined,
    () => undefined,
  )
  model.change({ kind: "pick", agent: "configured", recent: first })
  model.change({ kind: "favorite", model: first })
  model.change({ kind: "favorite", model: first })
  model.change({ kind: "variant", key: "local/one", value: "default" })
  model.change({ kind: "pick", agent: "__proto__", model: second })
  await model.flush()
  await port.settle()
  const data = JSON.parse(await fs.readFile(file, "utf8"))
  expect(data.unknown).toBe(true)
  expect(data.model.keep).toEqual(second)
  expect(Object.hasOwn(data.model, "configured")).toBe(false)
  expect(Object.hasOwn(data.model, "__proto__")).toBe(true)
  expect(data.favorite).toEqual([])
  expect(data.variant).toEqual({ keep: "none", "local/one": "default" })
  expect(data.recent).toHaveLength(10)
  expect(data.recent[0]).toEqual(first)
  expect(reduce(data, { kind: "pick", agent: "keep" }).model).not.toHaveProperty("keep")
})

test("interrupted actual TUI scope joins a blocked publication and actual filesystem finalizer", async () => {
  await using tmp = await tmpdir()
  const owner = ModelOwner.make({ publish: () => undefined })
  const entered = signal()
  const release = signal()
  const begun = signal()
  const finalizer = signal()
  const finish = signal()
  const file = path.join(tmp.path, "model.json")
  const gate = coordinateProfileWriters(
    {
      version: 1,
      id: "tui-model-interrupted",
      roots: [
        { kind: "json", path: file },
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
  const abort = new AbortController()
  let settled = false
  const work = Effect.runPromiseExit(
    scope(
      tmp.path,
      (port) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await fs.writeFile(path.join(tmp.path, "finalizer.txt"), "actual cleanup")
              finalizer.resolve()
              await finish.promise
            }),
          )
          void port.change((data) => reduce(data, { kind: "variant", key: "local/one", value: "none" }))
          begun.resolve()
          return yield* Effect.never
        }),
      owner,
    ),
    { signal: abort.signal },
  ).then((exit) => {
    settled = true
    return exit
  })
  await begun.promise
  abort.abort()
  await finalizer.promise
  expect(await fs.readFile(path.join(tmp.path, "finalizer.txt"), "utf8")).toBe("actual cleanup")
  expect(settled).toBe(false)
  expect(owner.snapshot().active).toBe(1)
  finish.resolve()
  await Bun.sleep(40)
  expect(settled).toBe(false)
  release.resolve()
  await gate
  const exit = await work
  expect(exit._tag).toBe("Failure")
  expect(owner.snapshot().active).toBe(0)
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ variant: { "local/one": "none" } })
  await owner.drain()
})

test("an actual canonical alias rebound during admission cannot retarget the reserved TUI intent", async () => {
  await using tmp = await tmpdir()
  const first = path.join(tmp.path, "first")
  const second = path.join(tmp.path, "second")
  const alias = path.join(tmp.path, "alias")
  await fs.mkdir(first)
  await fs.mkdir(second)
  await fs.writeFile(path.join(first, "model.json"), '{"original":true}')
  await fs.writeFile(path.join(second, "model.json"), '{"foreign":true}')
  await fs.symlink(first, alias, process.platform === "win32" ? "junction" : "dir")
  const owner = ModelOwner.make({ publish: () => undefined })
  const port = make(alias, owner)
  await port.read()
  const entered = signal()
  const release = signal()
  const gate = coordinateProfileWriters(
    {
      version: 1,
      id: "tui-model-alias",
      roots: [
        { kind: "json", path: path.join(first, "model.json") },
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
  const job = port.change((data) =>
    reduce(data, { kind: "pick", agent: "code", model: { providerID: "local", modelID: "exact" } }),
  )
  const result = job.then(
    () => undefined,
    (err: unknown) => err,
  )
  await Bun.sleep(50)
  expect(owner.snapshot().active).toBe(1)
  await fs.unlink(alias)
  await fs.symlink(second, alias, process.platform === "win32" ? "junction" : "dir")
  release.resolve()
  await gate
  const err = await result
  expect(err).toBeInstanceOf(Error)
  await Promise.resolve(expect(port.settle()).rejects.toBe(err))
  expect(await fs.readFile(path.join(first, "model.json"), "utf8")).toBe('{"original":true}')
  expect(await fs.readFile(path.join(second, "model.json"), "utf8")).toBe('{"foreign":true}')
  expect(owner.snapshot().active).toBe(0)
  await Promise.resolve(expect(owner.drain()).rejects.toBe(err))
})

test("body finalizer defects remain alongside original body and actual publication failure", async () => {
  await using tmp = await tmpdir()
  const owner = ModelOwner.make({ publish: () => undefined })
  const original = new Error("original body")
  const cleanup = new Error("body cleanup")
  const write = new Error("publication")
  const exit = await Effect.runPromiseExit(
    scope(
      tmp.path,
      (port) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.die(cleanup))
          const job = port.change(() => {
            throw write
          })
          yield* Effect.promise(() =>
            job.catch((err) => {
              expect(err).toBe(write)
            }),
          )
          return yield* Effect.fail(original)
        }),
      owner,
    ),
  )
  if (exit._tag !== "Failure") throw new Error("Expected real failure")
  const err = Cause.squash(exit.cause)
  if (!(err instanceof AggregateError)) throw new Error("Expected retained aggregate")
  const body = err.errors.find((error: unknown) => error instanceof AggregateError)
  if (!(body instanceof AggregateError)) throw new Error("Expected body/finalizer aggregate")
  expect(body.errors).toContain(original)
  expect(body.errors).toContain(cleanup)
  expect(err.errors).toContain(write)
  expect(owner.snapshot().active).toBe(0)
  await Promise.resolve(expect(owner.drain()).rejects.toBe(write))
})

test("destroyed delivery stays fenced while genuine FileHandle hydration and publication finish", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await fs.writeFile(file, '{"original":true}')
  const owner = ModelOwner.make({ publish: () => undefined })
  const entered = signal()
  const release = signal()
  let renders = 0
  let ready = 0
  let closed = false
  let settled = false
  const work = Effect.runPromise(
    scope(
      tmp.path,
      (port) =>
        Effect.sync(() => {
          const model = projection(
            port,
            () => {
              renders++
            },
            () => {
              ready++
            },
          )
          model.change({ kind: "variant", key: "local/one", value: "default" })
          expect(owner.snapshot().active).toBe(1)
          model.close()
          expect(() => model.change({ kind: "favorite", model: first })).toThrow("delivery is retired")
        }),
      owner,
      async () => {
        const handle = await fs.open(file, "r")
        try {
          const before = await handle.stat({ bigint: true })
          const text = await handle.readFile("utf8")
          entered.resolve()
          await release.promise
          const after = await handle.stat({ bigint: true })
          expect(after.ino).toBe(before.ino)
          expect(after.dev).toBe(before.dev)
          expect(after.size).toBe(before.size)
          const data: unknown = JSON.parse(text)
          const valid = (value: unknown): value is Record<string, unknown> =>
            value !== null && typeof value === "object" && !Array.isArray(value)
          if (!valid(data)) throw new Error("Invalid actual fixture")
          return data
        } finally {
          await handle.close()
          closed = true
        }
      },
    ),
  ).then(() => {
    settled = true
  })
  await entered.promise
  await Bun.sleep(40)
  expect(settled).toBe(false)
  expect(closed).toBe(false)
  expect(owner.snapshot().active).toBe(1)
  expect(renders).toBe(1)
  expect(ready).toBe(0)
  release.resolve()
  await work
  expect(closed).toBe(true)
  expect(owner.snapshot().active).toBe(0)
  expect(renders).toBe(1)
  expect(ready).toBe(0)
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ original: true, variant: { "local/one": "default" } })
  await owner.drain()
})

test("real hydration rendering failure is retained by production scope without explicit flush", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "model.json"), '{"original":true}')
  const owner = ModelOwner.make({ publish: () => undefined })
  const error = new Error("hydration render")
  const exit = await Effect.runPromiseExit(
    scope(
      tmp.path,
      (port) =>
        Effect.sync(() => {
          projection(
            port,
            () => {
              throw error
            },
            () => undefined,
          )
        }),
      owner,
    ),
  )
  if (exit._tag !== "Failure") throw new Error("Expected real delivery failure")
  expect(Cause.squash(exit.cause)).toBe(error)
  expect(owner.snapshot().active).toBe(0)
  await owner.drain()
})

test("optimistic rendering failure still joins the genuine accepted publication", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "model.json"), '{"original":true}')
  const owner = ModelOwner.make({ publish: () => undefined })
  const error = new Error("optimistic render")
  const exit = await Effect.runPromiseExit(
    scope(
      tmp.path,
      (port) =>
        Effect.sync(() => {
          const model = projection(
            port,
            () => {
              throw error
            },
            () => undefined,
          )
          expect(() => model.change({ kind: "variant", key: "local/one", value: "default" })).toThrow(error)
          model.close()
        }),
      owner,
    ),
  )
  if (exit._tag !== "Failure") throw new Error("Expected retained rendering failure")
  expect(Cause.squash(exit.cause)).toBe(error)
  expect(JSON.parse(await fs.readFile(path.join(tmp.path, "model.json"), "utf8"))).toEqual({
    original: true,
    variant: { "local/one": "default" },
  })
  expect(owner.snapshot().active).toBe(0)
  await owner.drain()
})
