import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { Global } from "../../src/global"
import { EffectFlock } from "../../src/util/effect-flock"
import { Hash } from "../../src/util/hash"
import { tmpdir } from "../fixture/tmpdir"

function graph(root: string) {
  return AppNodeBuilder.build(EffectFlock.node, [
    [Global.node, Global.layerWith({ state: path.join(root, "state", "kilo") })],
  ])
}

test("first acquisition and repeated acquisition retain an unchanged default parent", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "state", "kilo", "locks")
  const key = `review:${tmp.path}`
  const tokens: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const body = Effect.promise(async () => {
        const saved = JSON.parse(await fs.readFile(path.join(root, Hash.fast(key) + ".lock", "meta.json"), "utf8"))
        expect(saved.pid).toBe(process.pid)
        expect(typeof saved.token).toBe("string")
        expect(saved.token.length).toBeGreaterThan(0)
        tokens.push(saved.token)
      })
      yield* flock.withLock(body, key)
      const prior = yield* Effect.promise(() => fs.stat(root))
      expect(prior.isDirectory()).toBe(true)
      expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([])
      yield* flock.withLock(body, key, undefined, { strict: true })
      const current = yield* Effect.promise(() => fs.stat(root))
      expect(current.isDirectory()).toBe(true)
      expect(current.dev).toBe(prior.dev)
      expect(current.ino).toBe(prior.ino)
      expect(tokens).toHaveLength(2)
      expect(tokens[1]).not.toBe(tokens[0])
      expect(yield* Effect.promise(() => fs.readdir(root))).toEqual([])
    }).pipe(Effect.provide(graph(tmp.path))),
  )
})

for (const strict of [false, true])
  test(`the same ${strict ? "strict" : "ordinary"} service reacquires after its empty default lock root is removed`, async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state", "kilo", "locks")
    const key = `review:${tmp.path}`
    const tokens: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const body = Effect.promise(async () => {
          const file = path.join(root, Hash.fast(key) + ".lock", "meta.json")
          const saved = JSON.parse(await fs.readFile(file, "utf8"))
          expect(saved.pid).toBe(process.pid)
          expect(typeof saved.token).toBe("string")
          expect(saved.token.length).toBeGreaterThan(0)
          tokens.push(saved.token)
        })
        yield* flock.withLock(body, key, undefined, strict ? { strict: true } : undefined)
        yield* Effect.promise(async () => {
          expect(await fs.readdir(root)).toEqual([])
          // Non-recursive removal succeeds only after the original owner released.
          await fs.rmdir(root)
        })
        yield* flock.withLock(body, key, undefined, strict ? { strict: true } : undefined)
        yield* Effect.promise(async () => {
          expect(tokens).toHaveLength(2)
          expect(tokens[1]).not.toBe(tokens[0])
          expect(await fs.readdir(root)).toEqual([])
        })
      }).pipe(Effect.provide(graph(tmp.path))),
    )
  })

test("strict root recovery refuses an obstructing file without entering the protected body", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "state", "kilo", "locks")
  const key = `review:${tmp.path}`
  const marker = "Preserve this actual conflicting file."
  let entered = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      yield* flock.withLock(Effect.void, key, undefined, { strict: true })
      yield* Effect.promise(async () => {
        expect(await fs.readdir(root)).toEqual([])
        await fs.rmdir(root)
        await fs.writeFile(root, marker, { flag: "wx" })
      })
      const result = yield* flock
        .withLock(
          Effect.sync(() => {
            entered = true
          }),
          key,
          undefined,
          { strict: true },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(entered).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(root, "utf8"))).toBe(marker)
    }).pipe(Effect.provide(graph(tmp.path))),
  )
})

test("strict release refuses replaced owner metadata and preserves its actual lock directory", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "state", "kilo", "locks")
  const key = `review:${tmp.path}`
  const dir = path.join(root, Hash.fast(key) + ".lock")
  const token = crypto.randomUUID()
  await Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const result = yield* flock
        .withLock(
          Effect.promise(async () => {
            const file = path.join(dir, "meta.json")
            const prior = JSON.parse(await fs.readFile(file, "utf8"))
            expect(prior.token).not.toBe(token)
            await fs.writeFile(file, JSON.stringify({ ...prior, token }))
          }),
          key,
          undefined,
          { strict: true },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      yield* Effect.promise(async () => {
        expect(JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8")).token).toBe(token)
        expect((await fs.stat(path.join(dir, "heartbeat"))).isFile()).toBe(true)
      })
    }).pipe(Effect.provide(graph(tmp.path))),
  )
})
