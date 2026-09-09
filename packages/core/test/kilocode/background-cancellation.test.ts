import { expect, test } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Deferred, Effect, Fiber } from "effect"

test("invocation origins preserve mixed and unknown work and cannot be rewritten through snapshots", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        const origin = { sessionID: "parent", messageID: "assistant", callID: "first" }
        const first = yield* jobs.start({ type: "task", origin, run: Effect.never })
        origin.callID = "mutated"
        first.origins![0]!.callID = "mutated snapshot"
        expect((yield* jobs.get(first.id))?.origins).toEqual([
          { sessionID: "parent", messageID: "assistant", callID: "first" },
        ])
        yield* jobs.extend({ id: first.id, origin: { ...origin, callID: "second" }, run: Effect.never })
        yield* jobs.extend({ id: first.id, run: Effect.never })
        expect((yield* jobs.get(first.id))?.origins).toEqual([
          { sessionID: "parent", messageID: "assistant", callID: "first" },
          { sessionID: "parent", messageID: "assistant", callID: "second" },
          undefined,
        ])
        yield* jobs.cancel(first.id)
        const replacement = yield* jobs.start({ id: first.id, type: "task", run: Effect.never })
        expect(replacement.origins).toEqual([undefined])
      }),
    ),
  )
})

test("conditional cancellation rejects extensions and reused job IDs", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        const first = yield* jobs.start({ id: "child", type: "task", run: Effect.never })
        expect(typeof first.revision).toBe("string")
        expect((yield* jobs.get(first.id))?.revision).toBe(first.revision)
        expect((yield* jobs.list())[0].revision).toBe(first.revision)
        expect((yield* jobs.start({ id: first.id, type: "task", run: Effect.never })).revision).toBe(first.revision)
        expect(yield* jobs.extend({ id: first.id, run: Effect.never })).toBe(true)
        const extended = yield* jobs.get(first.id)
        expect(extended?.revision).not.toBe(first.revision)
        expect(yield* jobs.cancel(first.id, first.revision)).toBeUndefined()
        expect((yield* jobs.get(first.id))?.status).toBe("running")
        expect((yield* jobs.cancel(first.id, extended!.revision))?.status).toBe("cancelled")
        const replacement = yield* jobs.start({ id: first.id, type: "task", run: Effect.never })
        expect(replacement.revision).not.toBe(extended?.revision)
        expect(yield* jobs.cancel(first.id, extended!.revision)).toBeUndefined()
        expect((yield* jobs.get(first.id))?.status).toBe("running")
        expect((yield* jobs.cancel(first.id, replacement.revision))?.status).toBe("cancelled")
      }),
    ),
  )
})

test("matching cancellation awaits cleanup and does not claim completed work was cancelled", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        const cleanup = yield* Deferred.make<void>()
        const running = yield* jobs.start({
          type: "task",
          run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(cleanup, undefined))),
        })
        expect((yield* jobs.cancel(running.id, running.revision))?.status).toBe("cancelled")
        expect(yield* Deferred.isDone(cleanup)).toBe(true)
        const done = yield* jobs.start({ type: "task", run: Effect.succeed("done") })
        yield* jobs.wait({ id: done.id })
        expect((yield* jobs.cancel(done.id, done.revision))?.status).toBe("completed")
        expect(yield* jobs.cancel("missing", "revision")).toBeUndefined()
      }),
    ),
  )
})

test("an abandoned cancellation waiter leaves cleanup owned by the registry and preserves a replacement", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        const started = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        const job = yield* jobs.start({
          id: "shared-child",
          type: "task",
          run: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleanup, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Deferred.succeed(closed, undefined)),
              ),
            ),
          ),
        })
        yield* Deferred.await(started)
        const waiter = yield* jobs.cancel(job.id, job.revision).pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        const abandoned = yield* Fiber.interrupt(waiter).pipe(
          Effect.timeoutOption(1000),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        )
        expect(abandoned._tag).toBe("Some")
        yield* Deferred.await(closed)
        const replacement = yield* jobs.start({ id: job.id, type: "task", run: Effect.never })
        expect(replacement.revision).not.toBe(job.revision)
        expect(yield* jobs.cancel(job.id, job.revision)).toBeUndefined()
        expect((yield* jobs.get(job.id))?.status).toBe("running")
        yield* jobs.cancel(job.id, replacement.revision)
      }),
    ),
  )
})

test("cancelling a running invocation waits for cleanup without cancelling an unrelated extension", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        const ready = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const next = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const origin = {
          sessionID: "parent",
          messageID: "assistant",
          callID: "owned",
          childSessionID: "child",
          childMessageID: "first",
        }
        const job = yield* jobs.start({
          id: "child",
          type: "task",
          origin,
          run: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release)))),
          ),
        })
        yield* Deferred.await(ready)
        yield* jobs.extend({
          id: job.id,
          origin: { ...origin, callID: "unrelated", childMessageID: "second" },
          run: Deferred.succeed(next, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as("unrelated output"),
          ),
        })
        const current = (yield* jobs.get(job.id))!
        expect(yield* jobs.cancelInput(job.id, job.revision!, "first")).toBe(false)
        expect(yield* jobs.cancelInput(job.id, current.revision!, "missing")).toBe(false)
        const waiter = yield* jobs.cancelInput(job.id, current.revision!, "first").pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        yield* Fiber.interrupt(waiter)
        expect(yield* Deferred.isDone(next)).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(next)
        expect((yield* jobs.get(job.id))?.status).toBe("running")
        yield* Deferred.succeed(finish, undefined)
        expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
          status: "completed",
          output: "unrelated output",
        })
      }),
    ),
  )
})

test("cancelling a queued invocation skips only that input and retains serial ordering", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        const release = yield* Deferred.make<void>()
        const calls: string[] = []
        const origin = {
          sessionID: "parent",
          messageID: "assistant",
          callID: "one",
          childSessionID: "child",
          childMessageID: "first",
        }
        const job = yield* jobs.start({
          id: "child",
          type: "task",
          origin,
          run: Deferred.await(release).pipe(Effect.as("first")),
        })
        yield* jobs.extend({
          id: job.id,
          origin: { ...origin, callID: "two", childMessageID: "second" },
          run: Effect.sync(() => {
            calls.push("second")
            return "second"
          }),
        })
        const selected = (yield* jobs.get(job.id))!
        expect(yield* jobs.cancelInput(job.id, selected.revision!, "second")).toBe(true)
        yield* jobs.extend({
          id: job.id,
          run: Effect.sync(() => {
            calls.push("third")
            return "third"
          }),
        })
        expect(calls).toEqual([])
        expect(yield* jobs.cancelInput(job.id, selected.revision!, "second")).toBe(false)
        yield* Deferred.succeed(release, undefined)
        expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({ status: "completed", output: "third" })
        expect(calls).toEqual(["third"])
        const replacement = yield* jobs.start({ id: job.id, type: "task", origin, run: Effect.never })
        expect(yield* jobs.cancelInput(job.id, selected.revision!, "first")).toBe(false)
        yield* jobs.extend({ id: job.id, origin, run: Effect.never })
        expect(yield* jobs.cancelInput(job.id, (yield* jobs.get(job.id))!.revision!, "first")).toBe(false)
        expect((yield* jobs.get(job.id))?.status).toBe("running")
        yield* jobs.cancel(job.id)
        expect(replacement.revision).not.toBe(selected.revision)
      }),
    ),
  )
})

test("a cancelled final input reports cancellation while retaining the earlier successful output", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        const release = yield* Deferred.make<void>()
        const job = yield* jobs.start({
          id: "last-cancelled",
          type: "task",
          run: Deferred.await(release).pipe(Effect.as("completed earlier work")),
        })
        yield* jobs.extend({
          id: job.id,
          origin: {
            sessionID: "parent",
            messageID: "assistant",
            callID: "last",
            childSessionID: job.id,
            childMessageID: "last",
          },
          run: Effect.die("Cancelled input must not execute"),
        })
        const current = (yield* jobs.get(job.id))!
        expect(yield* jobs.cancelInput(job.id, current.revision!, "last")).toBe(true)
        expect((yield* jobs.get(job.id))?.status).toBe("running")
        yield* Deferred.succeed(release, undefined)
        expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
          status: "cancelled",
          output: "completed earlier work",
          error: "Task invocation cancelled",
        })
      }),
    ),
  )
})
