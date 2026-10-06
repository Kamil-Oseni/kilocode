import { expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect"
import { make } from "@opencode-ai/core/background-job"
import { retire } from "@/kilocode/session/background-retirement"
import * as Lineage from "@opencode-ai/core/kilocode/background-lineage"
import * as Invocation from "@opencode-ai/core/kilocode/background-invocation"

const revision = (job: { revision?: string } | undefined) => {
  if (!job?.revision) throw new Error("Expected an admitted execution revision")
  return job.revision
}

for (const kind of ["pending", "failed"]) {
  test(`registry disposal retains a ${kind} original scope across same-ID replacement`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make("parallel")
          const lineage = yield* Lineage.make
          const jobs = yield* make.pipe(
            Effect.provideService(Lineage.Service, lineage),
            Effect.provideService(Scope.Scope, scope),
          )
          const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
          const body = yield* Deferred.make<void>()
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const stopped = yield* Deferred.make<void>()
          const disposed = yield* Deferred.make<void>()
          const count = { value: 0 }
          const old = yield* jobs.start({
            id: "replaced-scope",
            type: "task",
            run: Effect.gen(function* () {
              const owner = yield* Effect.serviceOption(Invocation.Owner)
              if (owner._tag === "None") throw new Error("Actual invocation owner required")
              yield* Deferred.succeed(retained, owner.value)
              yield* Deferred.await(body)
              return "complete"
            }),
          })
          const owner = yield* Deferred.await(retained)
          const entry = lineage.entries.get(owner.token)
          if (!entry) throw new Error("Original admission required")
          yield* Scope.addFinalizer(
            entry.scope,
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              count.value++
              if (kind === "failed") return yield* Effect.die(new Error("replaced original scope failed"))
              return undefined
            }),
          )
          yield* Deferred.succeed(body, undefined)
          yield* jobs.wait({ id: old.id })
          yield* Deferred.await(entered)
          if (kind === "failed") {
            yield* Deferred.succeed(release, undefined)
            expect(Exit.isFailure(yield* Deferred.await(entry.retirement.done))).toBe(true)
          }
          const next = yield* jobs.start({
            id: old.id,
            type: "task",
            run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
          })
          expect(next.revision).not.toBe(old.revision)
          const close = yield* Effect.exit(Scope.close(scope, Exit.void)).pipe(
            Effect.tap(() => Deferred.succeed(disposed, undefined)),
            Effect.forkChild,
          )
          yield* Deferred.await(stopped)
          yield* Effect.yieldNow
          if (kind === "pending") expect(yield* Deferred.isDone(disposed)).toBe(false)
          yield* Deferred.succeed(release, undefined)
          const exit = yield* Fiber.join(close)
          expect(Exit.isFailure(exit)).toBe(kind === "failed")
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("replaced original scope failed")
          expect(count.value).toBe(1)
          expect(lineage.entries.size).toBe(0)
        }),
      ),
    )
  })
}

test("registry scope disposal and a concurrent retirement share the original pending close", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make("parallel")
        const lineage = yield* Lineage.make
        const jobs = yield* make.pipe(
          Effect.provideService(Lineage.Service, lineage),
          Effect.provideService(Scope.Scope, scope),
        )
        const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const disposed = yield* Deferred.make<void>()
        const root = yield* jobs.start({
          type: "task",
          run: Effect.gen(function* () {
            const owner = yield* Effect.serviceOption(Invocation.Owner)
            if (owner._tag === "None") throw new Error("Actual invocation owner required")
            yield* Deferred.succeed(retained, owner.value)
            return yield* Effect.never
          }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined).pipe(Effect.andThen(Deferred.await(release))))),
        })
        const owner = yield* Deferred.await(retained)
        const entry = lineage.entries.get(owner.token)
        if (!entry) throw new Error("Original admission required")
        yield* Scope.addFinalizer(
          entry.scope,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        const first = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Deferred.await(stopped)
        const second = yield* Lineage.close(lineage, entry.retirement).pipe(
          Effect.tap(() => Deferred.succeed(disposed, undefined)),
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        const premature = yield* Deferred.isDone(disposed)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(premature).toBe(false)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect(lineage.entries.size).toBe(0)
        expect(
          Exit.isFailure(yield* Effect.exit(jobs.start({ id: root.id, type: "task", run: Effect.succeed("late") }))),
        ).toBe(true)
      }),
    ),
  )
})

test("concurrent scope-close failure stays attached to its original completion and is never retried", async () => {
  const result = await Effect.runPromise(
    Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const lineage = yield* Lineage.make
          const jobs = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
          const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
          const count = { value: 0 }
          const root = yield* jobs.start({
            type: "task",
            run: Effect.gen(function* () {
              const owner = yield* Effect.serviceOption(Invocation.Owner)
              if (owner._tag === "None") throw new Error("Actual invocation owner required")
              yield* Deferred.succeed(retained, owner.value)
              return yield* Effect.never
            }),
          })
          const owner = yield* Deferred.await(retained)
          const entry = lineage.entries.get(owner.token)
          if (!entry) throw new Error("Original admission required")
          yield* Scope.addFinalizer(
            entry.scope,
            Effect.sync(() => count.value++).pipe(
              Effect.andThen(Effect.die(new Error("original scope cleanup failed"))),
            ),
          )
          const first = yield* Effect.exit(jobs.cancelTree(root.id, revision(root)))
          const second = yield* Effect.exit(retire(jobs, root))
          expect(Exit.isFailure(first)).toBe(true)
          expect(Exit.isFailure(second)).toBe(true)
          if (Exit.isFailure(first)) expect(Cause.pretty(first.cause)).toContain("original scope cleanup failed")
          if (Exit.isFailure(second)) expect(Cause.pretty(second.cause)).toContain("original scope cleanup failed")
          expect(count.value).toBe(1)
          expect(lineage.entries.size).toBe(0)
        }),
      ),
    ),
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("original scope cleanup failed")
})

test("service disposal retains a natural scope-close failure which already completed", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make("parallel")
        const lineage = yield* Lineage.make
        const jobs = yield* make.pipe(
          Effect.provideService(Lineage.Service, lineage),
          Effect.provideService(Scope.Scope, scope),
        )
        const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const release = yield* Deferred.make<void>()
        const count = { value: 0 }
        const root = yield* jobs.start({
          type: "task",
          run: Effect.gen(function* () {
            const owner = yield* Effect.serviceOption(Invocation.Owner)
            if (owner._tag === "None") throw new Error("Actual invocation owner required")
            yield* Deferred.succeed(retained, owner.value)
            yield* Deferred.await(release)
            return "complete"
          }),
        })
        const owner = yield* Deferred.await(retained)
        const entry = lineage.entries.get(owner.token)
        if (!entry) throw new Error("Original admission required")
        yield* Scope.addFinalizer(
          entry.scope,
          Effect.sync(() => count.value++).pipe(
            Effect.andThen(Effect.die(new Error("completed original scope failure"))),
          ),
        )
        yield* Deferred.succeed(release, undefined)
        expect((yield* jobs.wait({ id: root.id })).info?.status).toBe("completed")
        const original = yield* Deferred.await(entry.retirement.done)
        expect(Exit.isFailure(original)).toBe(true)
        const disposed = yield* Effect.exit(Scope.close(scope, Exit.void))
        expect(Exit.isFailure(disposed)).toBe(true)
        if (Exit.isFailure(disposed)) expect(Cause.pretty(disposed.cause)).toContain("completed original scope failure")
        expect(count.value).toBe(1)
        expect(lineage.entries.size).toBe(0)
      }),
    ),
  )
})

test("completed scope cleanup stays owned until Session disposal joins its original finalizer", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lineage = yield* Lineage.make
        const jobs = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const body = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const disposed = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const root = yield* jobs.start({
          type: "task",
          run: Effect.gen(function* () {
            const owner = yield* Effect.serviceOption(Invocation.Owner)
            if (owner._tag === "None") throw new Error("Actual invocation owner required")
            yield* Deferred.succeed(retained, owner.value)
            yield* Deferred.await(body)
            return "complete"
          }),
        })
        const owner = yield* Deferred.await(retained)
        const entry = lineage.entries.get(owner.token)
        if (!entry) throw new Error("Original admission required")
        yield* Scope.addFinalizer(
          entry.scope,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Deferred.succeed(stopped, undefined)),
          ),
        )
        yield* Deferred.succeed(body, undefined)
        const observed = (yield* jobs.wait({ id: root.id })).info
        if (!observed) throw new Error("Completed original observation required")
        yield* Deferred.await(entered)
        yield* Deferred.await(entry.control.joined)
        yield* Lineage.prune(lineage)
        const present = lineage.entries.has(owner.token)
        const cancel = yield* retire(jobs, observed).pipe(
          Effect.tap(() => Deferred.succeed(disposed, undefined)),
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        const premature = yield* Deferred.isDone(disposed)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(cancel)
        expect(present).toBe(true)
        expect(premature).toBe(false)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect(lineage.entries.size).toBe(0)
      }),
    ),
  )
})

test("a completed invocation cannot reopen its remaining fenced job during original cleanup", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lineage = yield* Lineage.make
        const jobs = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const release = yield* Deferred.make<void>()
        const ready = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const root = yield* jobs.start({
          type: "task",
          run: Effect.gen(function* () {
            const owner = yield* Effect.serviceOption(Invocation.Owner)
            if (owner._tag === "None") throw new Error("Actual invocation owner required")
            yield* Deferred.succeed(retained, owner.value)
            yield* Deferred.await(release)
            return "first"
          }),
        })
        const owner = yield* Deferred.await(retained)
        const entry = lineage.entries.get(owner.token)
        if (!entry) throw new Error("Original live admission required")
        expect(
          yield* jobs.extend({
            id: root.id,
            run: Deferred.succeed(ready, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.andThen(Deferred.succeed(stopped, undefined)),
                ),
              ),
            ),
          }),
        ).toBe(true)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(ready)
        yield* Deferred.await(entry.control.joined)
        yield* Lineage.prune(lineage)
        expect(lineage.entries.has(owner.token)).toBe(true)
        const current = yield* jobs.get(root.id)
        const cancel = yield* jobs.cancelTree(root.id, revision(current)).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const extended = yield* Effect.exit(jobs.extend({ id: root.id, run: Effect.succeed("late") }))
        const restarted = yield* Effect.exit(jobs.start({ id: root.id, type: "task", run: Effect.succeed("late") }))
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(cancel)
        expect(Exit.isFailure(extended)).toBe(true)
        expect(Exit.isFailure(restarted)).toBe(true)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* jobs.get(root.id))?.status).toBe("cancelled")
        expect(lineage.entries.size).toBe(0)
      }),
    ),
  )
})

test("joined lineage releases finished leaves while retaining a completed ancestor for its active descendant", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lineage = yield* Lineage.make
        const first = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const second = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const ready = yield* Deferred.make<string>()
        const stopped = yield* Deferred.make<void>()
        const root = yield* first.start({
          type: "task",
          run: Effect.gen(function* () {
            const owner = yield* Effect.serviceOption(Invocation.Owner)
            if (owner._tag === "None") throw new Error("Actual invocation owner required")
            yield* Deferred.succeed(retained, owner.value)
            const child = yield* second.start({
              type: "task",
              run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
            })
            yield* Deferred.succeed(ready, child.id)
            return "complete"
          }),
        })
        const owner = yield* Deferred.await(retained)
        const child = yield* Deferred.await(ready)
        yield* first.wait({ id: root.id })
        const entry = lineage.entries.get(owner.token)
        if (!entry) throw new Error("Active descendant must retain its original ancestor")
        yield* Deferred.await(entry.control.joined)
        yield* Lineage.prune(lineage)
        expect(lineage.entries.size).toBe(2)
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              second
                .start({ type: "task", run: Effect.succeed("late") })
                .pipe(Effect.provideService(Invocation.Owner, owner)),
            ),
          ),
        ).toBe(true)
        const observed = yield* first.get(root.id)
        if (!observed) throw new Error("Original completed execution required")
        yield* retire(first, observed)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* second.get(child))?.status).toBe("cancelled")
        expect(lineage.entries.size).toBe(0)
        const next = yield* first.start({ type: "task", run: Effect.succeed("done") })
        const completed = (yield* first.wait({ id: next.id })).info
        if (!completed) throw new Error("Original completed execution required")
        yield* retire(first, completed)
        expect(lineage.entries.size).toBe(0)
      }),
    ),
  )
})

test("retained completed revision never cancels a later job with the same session metadata", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* make
        const old = yield* jobs.start({
          id: "old",
          type: "task",
          metadata: { sessionId: "same" },
          run: Effect.succeed("done"),
        })
        yield* jobs.wait({ id: old.id })
        const next = yield* jobs.start({ type: "task", metadata: { sessionId: "same" }, run: Effect.never })
        expect(yield* jobs.cancelTree(old.id, revision(old))).toBe("terminal")
        expect((yield* jobs.get(next.id))?.status).toBe("running")
        expect(yield* jobs.cancelTree(next.id, revision(next))).toBe("cancelled")
      }),
    ),
  )
})

test("exact root cancellation joins a detached descendant and rejects admission from cancelled ancestry", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* make
        const ready = yield* Deferred.make<string>()
        const stopped = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const rejected = yield* Deferred.make<boolean>()
        const root = yield* jobs.start({
          type: "task",
          run: Effect.gen(function* () {
            const child = yield* jobs.start({
              type: "task",
              run: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
            })
            yield* Deferred.await(entered)
            yield* Deferred.succeed(ready, child.id)
            return yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const exit = yield* Effect.exit(jobs.start({ type: "task", run: Effect.succeed("must not start") }))
                yield* Deferred.succeed(rejected, Exit.isFailure(exit))
              }),
            ),
          ),
        })
        const id = yield* Deferred.await(ready)
        expect(yield* jobs.cancelTree(root.id, revision(root))).toBe("cancelled")
        expect(yield* Deferred.await(rejected)).toBe(true)
        yield* Deferred.await(stopped)
        expect((yield* jobs.get(id))?.status).toBe("cancelled")
        expect((yield* jobs.list()).length).toBe(2)
      }),
    ),
  )
})

test("revision changes refuse stale Stop after extension and restart", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* make
        const root = yield* jobs.start({ id: "reused", type: "task", run: Effect.never })
        expect(yield* jobs.extend({ id: root.id, run: Effect.never })).toBe(true)
        expect(yield* jobs.cancelTree(root.id, revision(root))).toBe("stale")
        const current = yield* jobs.get(root.id)
        expect(current?.status).toBe("running")
        expect(yield* jobs.cancelTree(root.id, revision(current))).toBe("cancelled")
        const next = yield* jobs.start({ id: root.id, type: "task", run: Effect.never })
        expect(yield* jobs.cancelTree(root.id, revision(current))).toBe("stale")
        expect((yield* jobs.get(next.id))?.status).toBe("running")
        yield* jobs.cancelTree(next.id, revision(next))
      }),
    ),
  )
})

test("mixed-parent queued invocation joins without stopping foreign work or breaking predecessor order", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* make
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const extended = yield* Deferred.make<void>()
        const successor = yield* Deferred.make<void>()
        const foreign = yield* jobs.start({
          id: "shared",
          type: "task",
          run: Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("first")),
        })
        yield* Deferred.await(ready)
        const root = yield* jobs.start({
          type: "task",
          run: Effect.gen(function* () {
            yield* jobs.extend({ id: foreign.id, run: Effect.die(new Error("cancelled queued body started")) })
            yield* Deferred.succeed(extended, undefined)
            return yield* Effect.never
          }),
        })
        yield* Deferred.await(extended)
        yield* jobs.cancelTree(root.id, revision(root))
        expect((yield* jobs.get(foreign.id))?.status).toBe("running")
        yield* jobs.extend({ id: foreign.id, run: Deferred.succeed(successor, undefined).pipe(Effect.as("last")) })
        expect(yield* Deferred.isDone(successor)).toBe(false)
        yield* Deferred.succeed(release, undefined)
        const result = yield* jobs.wait({ id: foreign.id })
        expect(result.info?.status).toBe("completed")
        expect(result.info?.output).toBe("last")
        expect(yield* Deferred.isDone(successor)).toBe(true)
      }),
    ),
  )
})

test("foreign invocation context cannot grant ancestry and cleanup failures are preserved", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* make
        const forged = yield* Effect.exit(
          jobs
            .start({ type: "task", run: Effect.succeed("bad") })
            .pipe(Effect.provideService(Invocation.Owner, { token: {} })),
        )
        expect(Exit.isFailure(forged)).toBe(true)
        expect((yield* jobs.list()).length).toBe(0)
        const ready = yield* Deferred.make<void>()
        const root = yield* jobs.start({
          type: "task",
          run: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.die(new Error("original cleanup failed"))),
          ),
        })
        yield* Deferred.await(ready)
        const exit = yield* Effect.exit(jobs.cancelTree(root.id, revision(root)))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("original cleanup failed")
      }),
    ),
  )
})

test("an interrupted HTTP waiter leaves selected original cleanup owned and preserves unrelated work", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* make
        const ready = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const root = yield* jobs.start({
          type: "task",
          run: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Deferred.succeed(stopped, undefined)),
              ),
            ),
          ),
        })
        const other = yield* jobs.start({ type: "task", run: Effect.never })
        yield* Deferred.await(ready)
        const cancel = yield* jobs.cancelTree(root.id, revision(root)).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const waiter = yield* Fiber.interrupt(cancel).pipe(Effect.forkChild)
        expect(yield* Deferred.isDone(stopped)).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(waiter)
        yield* Deferred.await(stopped)
        yield* jobs.wait({ id: root.id })
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* jobs.get(root.id))?.status).toBe("cancelled")
        expect((yield* jobs.get(other.id))?.status).toBe("running")
        yield* jobs.cancelTree(other.id, revision(other))
      }),
    ),
  )
})

test("one service-owned lineage crosses isolated registries without merging their observations", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lineage = yield* Lineage.make
        const first = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const second = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const other = yield* make
        const ready = yield* Deferred.make<string>()
        const stopped = yield* Deferred.make<void>()
        const root = yield* first.start({
          type: "task",
          run: Effect.gen(function* () {
            const forged = yield* Effect.exit(other.start({ type: "task", run: Effect.succeed("foreign domain") }))
            expect(Exit.isFailure(forged)).toBe(true)
            const child = yield* second.start({
              type: "task",
              run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
            })
            yield* Deferred.succeed(ready, child.id)
            return yield* Effect.never
          }),
        })
        const id = yield* Deferred.await(ready)
        expect(yield* first.get(id)).toBeUndefined()
        expect(yield* second.get(root.id)).toBeUndefined()
        expect((yield* other.list()).length).toBe(0)
        expect(yield* first.cancelTree(root.id, revision(root))).toBe("cancelled")
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* second.get(id))?.status).toBe("cancelled")
      }),
    ),
  )
})

test("completed retained owners cannot admit late work while an already admitted child keeps its own authority", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lineage = yield* Lineage.make
        const first = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const second = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const active = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const ready = yield* Deferred.make<string>()
        const root = yield* first.start({
          type: "task",
          run: Effect.gen(function* () {
            const owner = yield* Effect.serviceOption(Invocation.Owner)
            if (owner._tag === "None") throw new Error("Actual invocation owner required")
            yield* Deferred.succeed(retained, owner.value)
            const child = yield* second.start({
              type: "task",
              run: Effect.gen(function* () {
                const owner = yield* Effect.serviceOption(Invocation.Owner)
                if (owner._tag === "None") throw new Error("Actual invocation owner required")
                yield* Deferred.succeed(active, owner.value)
                return yield* Effect.never
              }),
            })
            yield* Deferred.succeed(ready, child.id)
            return "done"
          }),
        })
        yield* first.wait({ id: root.id })
        const owner = yield* Deferred.await(retained)
        const child = yield* Deferred.await(ready)
        const context = yield* Deferred.await(active)
        const late = yield* Effect.exit(
          second
            .start({ type: "task", run: Effect.succeed("must not start") })
            .pipe(Effect.provideService(Invocation.Owner, owner)),
        )
        const extension = yield* Effect.exit(
          second
            .extend({ id: child, run: Effect.succeed("must not extend") })
            .pipe(Effect.provideService(Invocation.Owner, owner)),
        )
        expect(Exit.isFailure(late)).toBe(true)
        expect(Exit.isFailure(extension)).toBe(true)
        const grandchild = yield* second
          .start({ type: "task", run: Effect.never })
          .pipe(Effect.provideService(Invocation.Owner, context))
        expect((yield* second.list()).length).toBe(2)
        expect(yield* first.cancelTree(root.id, revision(root))).toBe("terminal")
        expect((yield* second.get(grandchild.id))?.status).toBe("running")
        yield* second.cancelTree(child, revision(yield* second.get(child)))
        expect((yield* second.get(grandchild.id))?.status).toBe("cancelled")
      }),
    ),
  )
})

test("queued cross-registry admission rechecks the original owner after its completion fence", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lineage = yield* Lineage.make
        const first = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const second = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const retained = yield* Deferred.make<Context.Service.Shape<typeof Invocation.Owner>>()
        const release = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        const root = yield* first.start({
          type: "task",
          run: Effect.gen(function* () {
            const owner = yield* Effect.serviceOption(Invocation.Owner)
            if (owner._tag === "None") throw new Error("Actual invocation owner required")
            yield* Deferred.succeed(retained, owner.value)
            yield* Deferred.await(release)
            return "done"
          }).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
        })
        const owner = yield* Deferred.await(retained)
        const queued = yield* Semaphore.withPermit(
          lineage.lock,
          Effect.gen(function* () {
            yield* Deferred.succeed(release, undefined)
            yield* Deferred.await(finished)
            yield* Effect.yieldNow
            const attempt = yield* second
              .start({ type: "task", run: Effect.succeed("must not start") })
              .pipe(Effect.provideService(Invocation.Owner, owner), Effect.forkChild)
            yield* Effect.yieldNow
            return attempt
          }),
        )
        const exit = yield* Fiber.await(queued)
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* second.list()).length).toBe(0)
        expect((yield* first.wait({ id: root.id })).info?.status).toBe("completed")
      }),
    ),
  )
})

test("session disposal retires a completed original ancestor's active cross-directory tree without touching a replacement", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lineage = yield* Lineage.make
        const first = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const second = yield* make.pipe(Effect.provideService(Lineage.Service, lineage))
        const ready = yield* Deferred.make<string>()
        const stopped = yield* Deferred.make<void>()
        const root = yield* first.start({
          id: "disposal",
          type: "task",
          run: Effect.gen(function* () {
            const child = yield* second.start({
              type: "task",
              run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
            })
            yield* Deferred.succeed(ready, child.id)
            return "complete"
          }),
        })
        const child = yield* Deferred.await(ready)
        const old = (yield* first.wait({ id: root.id })).info
        if (!old) throw new Error("Original completed observation required")
        const other = yield* second.start({ type: "task", run: Effect.never })
        expect((yield* retire(first, old))?.status).toBe("completed")
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* second.get(child))?.status).toBe("cancelled")
        expect((yield* second.get(other.id))?.status).toBe("running")
        const replacement = yield* first.start({ id: root.id, type: "task", run: Effect.never })
        expect(yield* retire(first, old)).toBeUndefined()
        expect((yield* first.get(replacement.id))?.status).toBe("running")
        const missing = yield* Effect.exit(retire(first, { ...replacement, revision: undefined }))
        expect(Exit.isFailure(missing)).toBe(true)
        expect((yield* first.get(replacement.id))?.status).toBe("running")
        yield* retire(first, replacement)
        yield* retire(second, other)
      }),
    ),
  )
})
