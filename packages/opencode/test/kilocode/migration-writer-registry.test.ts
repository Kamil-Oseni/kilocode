import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"

const run = <A, E>(body: Effect.Effect<A, E>) => Effect.runPromise(body)

describe("profile writer registry", () => {
  test("requires an exact declared and registered manifest", async () => {
    expect(() => ProfileWriterRegistry.make([])).toThrow("manifest is empty")
    expect(() => ProfileWriterRegistry.make(["database", "database"])).toThrow("duplicate IDs")
    expect(() => ProfileWriterRegistry.make(["database", " "])).toThrow("empty ID")

    const registry = ProfileWriterRegistry.make(["storage", "database"])
    await expect(run(registry.register("unknown"))).rejects.toMatchObject({ code: "unknown-writer" })
    await run(registry.register("storage"))
    await expect(run(registry.register("storage"))).rejects.toMatchObject({ code: "duplicate-writer" })
    await expect(run(registry.run("database", Effect.void))).rejects.toMatchObject({ code: "unregistered-writer" })

    let called = false
    await expect(
      run(
        registry.quiesce(
          Effect.sync(() => {
            called = true
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "registry-incomplete", missing: ["database"] })
    expect(called).toBe(false)
    expect(await run(registry.snapshot)).toEqual({
      phase: "open",
      declared: ["database", "storage"],
      registered: ["storage"],
      active: [],
    })
  })

  test("accepts only a complete fully integrated manifest", async () => {
    expect(() =>
      ProfileWriterRegistry.fromManifest({
        complete: false,
        gaps: [],
        writers: [{ id: "storage", coverage: "integrated" }],
      }),
    ).toThrow("not complete and integrated")
    expect(() =>
      ProfileWriterRegistry.fromManifest({
        complete: true,
        gaps: ["unknown writer"],
        writers: [{ id: "storage", coverage: "integrated" }],
      }),
    ).toThrow("not complete and integrated")

    const registry = ProfileWriterRegistry.fromManifest({
      complete: true,
      gaps: [],
      writers: [{ id: "storage", coverage: "integrated" }],
    })
    await run(registry.register("storage"))
    expect(await run(registry.run("storage", Effect.succeed("ok")))).toBe("ok")
  })

  test("drains every writer and rejects late admission before entering quiescence", async () => {
    await run(
      Effect.gen(function* () {
        const registry = ProfileWriterRegistry.make(["storage", "database"])
        yield* registry.register("database")
        yield* registry.register("storage")
        const database = yield* Deferred.make<void>()
        const storage = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const first = yield* registry
          .run("database", Deferred.succeed(database, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild({ startImmediately: true }))
        const second = yield* registry
          .run("storage", Deferred.succeed(storage, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(database)
        yield* Deferred.await(storage)

        const closed = yield* registry
          .quiesce(Deferred.succeed(entered, undefined))
          .pipe(Effect.forkChild({ startImmediately: true }))
        expect(yield* registry.snapshot).toMatchObject({
          phase: "draining",
          active: [
            { id: "database", count: 1 },
            { id: "storage", count: 1 },
          ],
        })
        const late = yield* registry.run("storage", Effect.void).pipe(Effect.exit)
        expect(Exit.isFailure(late)).toBe(true)
        expect(yield* Deferred.isDone(entered)).toBe(false)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        yield* Fiber.join(closed)
        expect(yield* Deferred.isDone(entered)).toBe(true)
        expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })
      }),
    )
  })

  test("releases failed and interrupted writers", async () => {
    await run(
      Effect.gen(function* () {
        const registry = ProfileWriterRegistry.make(["storage"])
        yield* registry.register("storage")
        yield* registry.run("storage", Effect.fail("failed")).pipe(Effect.exit)
        expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })

        const entered = yield* Deferred.make<void>()
        const fiber = yield* registry
          .run("storage", Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        expect(yield* registry.snapshot).toMatchObject({ active: [{ id: "storage", count: 1 }] })
        yield* Fiber.interrupt(fiber)
        expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })
      }),
    )
  })

  test("reopens after failed or interrupted quiescence", async () => {
    await run(
      Effect.gen(function* () {
        const registry = ProfileWriterRegistry.make(["storage"])
        yield* registry.register("storage")
        yield* registry.quiesce(Effect.fail("copy failed")).pipe(Effect.exit)
        expect(yield* registry.snapshot).toMatchObject({ phase: "open" })

        const entered = yield* Deferred.make<void>()
        const fiber = yield* registry
          .quiesce(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        expect(yield* registry.snapshot).toMatchObject({ phase: "closed" })
        yield* Fiber.interrupt(fiber)
        expect(yield* registry.snapshot).toMatchObject({ phase: "open" })
        yield* registry.run("storage", Effect.void)
      }),
    )
  })
})
