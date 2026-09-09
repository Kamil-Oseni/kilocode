import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { observe } from "@/kilocode/effect/observation"
import { make } from "@/kilocode/session/task-worker"
import { MessageID, SessionID } from "@/session/schema"

const session = SessionID.make("ses_task_worker")
const adapter = (runner: Runner.Runner<string>) => ({
  inspect: (id: SessionID) => Effect.succeed(id === session ? observe(runner) : { phase: "idle" as const }),
  requestCancel: (_: SessionID, id: string) => runner.requestCancel(id),
})

test("cancellation before startup refuses the reserved input without blocking a different input", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runner = Runner.make<string>(yield* Scope.Scope)
        const workers = yield* make(adapter(runner))
        const message = MessageID.ascending()
        expect(yield* workers.cancel(session, message)).toBe(false)
        expect(yield* workers.bind(session, message)).toBe(false)
        yield* runner.ensureRunning(
          Effect.gen(function* () {
            expect(yield* workers.bind(session, message)).toBe(false)
            expect(yield* workers.bind(session, MessageID.ascending())).toBe(true)
            return "done"
          }).pipe(Effect.ensuring(workers.release)),
        )
      }),
    ),
  )
})

test("cleanup targets the current input and releases binding locks before waiting", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runner = Runner.make<string>(yield* Scope.Scope, { onInterrupt: Effect.succeed("stopped") })
        const workers = yield* make(adapter(runner))
        const first = MessageID.ascending()
        const next = MessageID.ascending()
        const ready = yield* Deferred.make<void>()
        const work = yield* runner
          .ensureRunning(
            Effect.gen(function* () {
              expect(yield* workers.bind(session, first)).toBe(true)
              expect(yield* workers.bind(session, next)).toBe(true)
              yield* Deferred.succeed(ready, undefined)
              return yield* Effect.never
            }).pipe(Effect.ensuring(workers.release)),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        const before = observe(runner)
        expect(yield* workers.bind(session, first)).toBe(false)
        expect(yield* workers.cancel(session, first)).toBe(false)
        expect(yield* workers.cancel(SessionID.make("ses_other"), next)).toBe(false)
        expect(observe(runner)).toEqual(before)
        expect(yield* workers.stop(session, [first, next])).toBe(true)
        expect(yield* Fiber.join(work)).toBe("stopped")
        expect(observe(runner).phase).toBe("idle")
      }),
    ),
  )
})

test("old cleanup cannot remove a replacement binding and an abandoned cancellation waiter does not stop cleanup", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runner = Runner.make<string>(yield* Scope.Scope, { onInterrupt: Effect.succeed("stopped") })
        const workers = yield* make(adapter(runner))
        const first = MessageID.ascending()
        const next = MessageID.ascending()
        const ready = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const original = yield* runner
          .ensureRunning(
            Effect.gen(function* () {
              expect(yield* workers.bind(session, first)).toBe(true)
              yield* Deferred.succeed(ready, undefined)
              return yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Deferred.succeed(cleanup, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(workers.release),
                ),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        const stopping = yield* workers.cancel(session, first).pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        yield* Fiber.interrupt(stopping)
        const started = yield* Deferred.make<void>()
        const replacement = yield* runner
          .ensureRunning(
            Effect.gen(function* () {
              expect(yield* workers.bind(session, next)).toBe(true)
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }).pipe(Effect.ensuring(workers.release)),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(original)).toBe("stopped")
        expect(yield* workers.cancel(session, first)).toBe(false)
        expect(yield* workers.cancel(session, next)).toBe(true)
        expect(yield* Fiber.join(replacement)).toBe("stopped")
      }),
    ),
  )
})
