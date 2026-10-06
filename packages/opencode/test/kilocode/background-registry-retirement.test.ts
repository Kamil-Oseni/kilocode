import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { make } from "@opencode-ai/core/background-job"
import * as Lineage from "@opencode-ai/core/kilocode/background-lineage"

test("a closing registry refuses new admission and promotion before its original finalizers settle", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential")
        const lineage = yield* Lineage.make
        const jobs = yield* make.pipe(
          Effect.provideService(Lineage.Service, lineage),
          Effect.provideService(Scope.Scope, scope),
        )
        const ready = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const disposed = yield* Deferred.make<void>()
        const counts = { run: 0, promote: 0 }
        const root = yield* jobs.start({
          type: "task",
          run: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
          onPromote: Effect.sync(() => counts.promote++),
        })
        yield* Deferred.await(ready)
        // The real sequential Scope closes first, then holds before registry cleanup acquires its fence.
        yield* Scope.addFinalizer(
          scope,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        const close = yield* Scope.close(scope, Exit.void).pipe(
          Effect.tap(() => Deferred.succeed(disposed, undefined)),
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        const started = yield* Effect.exit(
          jobs.start({ type: "task", run: Effect.sync(() => counts.run++).pipe(Effect.as("late")) }),
        )
        const extended = yield* Effect.exit(
          jobs.extend({ id: root.id, run: Effect.sync(() => counts.run++).pipe(Effect.as("late")) }),
        )
        const promoted = yield* jobs.promote(root.id)
        const current = yield* jobs.get(root.id)
        const premature = yield* Deferred.isDone(disposed)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(close)
        expect(Exit.isFailure(started)).toBe(true)
        expect(Exit.isFailure(extended)).toBe(true)
        expect(promoted).toBeUndefined()
        expect(current?.revision).toBe(root.revision)
        expect(current?.metadata?.background).not.toBe(true)
        expect(counts).toEqual({ run: 0, promote: 0 })
        expect(premature).toBe(false)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect(yield* Deferred.isDone(disposed)).toBe(true)
        expect(lineage.entries.size).toBe(0)
      }),
    ),
  )
})
