import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { BackgroundOutcome as Table } from "@opencode-ai/core/kilocode/background-outcome.sql"
import { make } from "@/kilocode/background/outcome"
import * as Observer from "@opencode-ai/core/kilocode/background-observer"
import * as Invocation from "@opencode-ai/core/kilocode/background-invocation"
import * as BackgroundJob from "@opencode-ai/core/background-job"
import { Service as OutcomeService } from "@opencode-ai/core/kilocode/background-outcome"
import * as Lineage from "@opencode-ai/core/kilocode/background-lineage"
import { tmpdir } from "../fixture/fixture"

const initial = {
  id: "owned-child",
  revision: "original-generation",
  type: "subagent",
  status: "running" as const,
  started_at: 1,
  origins: [
    {
      sessionID: "parent",
      messageID: "parent-message",
      callID: "task-call",
      childSessionID: "owned-child",
      childMessageID: "child-input",
    },
  ],
}
const terminal = { ...initial, status: "completed" as const, completed_at: 2, output: "original Unicode ✓ result" }
const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, file = ":memory:") =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(file))))

// These actual SQLite tests qualify original-row consistency, NOT native join
// observation. The production core observer must supply that original proof.
test("original outcome phases retain debt and refuse forged, foreign and changed writers", async () => {
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const api = yield* make(database)
        const token = yield* api.admit(initial)
        expect((yield* api.get(initial))?.phase).toBe("admitted")
        expect((yield* api.joined(token, terminal).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* api.observe({}, terminal).pipe(Effect.exit))._tag).toBe("Failure")
        const foreign = yield* make(database)
        expect((yield* foreign.observe(token, terminal).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* api.admit(initial).pipe(Effect.exit))._tag).toBe("Failure")
        yield* api.observe(token, terminal)
        expect((yield* api.get(initial))?.phase).toBe("terminal")
        expect((yield* api.joined(token, { ...terminal, output: "changed" }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(
          (yield* api.observe(token, { ...terminal, revision: "foreign-generation" }).pipe(Effect.exit))._tag,
        ).toBe("Failure")
        yield* api.joined(token, terminal)
        const observed = yield* api.get(initial)
        expect(observed?.phase).toBe("joined")
        expect(observed?.terminal?.output).toBe(terminal.output)
        yield* api.observe(token, terminal)
        yield* api.joined(token, terminal)
        expect(yield* api.get(initial)).toEqual(observed)
        const successor = { ...initial, revision: "next-generation" }
        const next = yield* api.admit(successor)
        expect((yield* api.observe(token, { ...terminal, revision: successor.revision }).pipe(Effect.exit))._tag).toBe(
          "Failure",
        )
        yield* api.observe(next, { ...terminal, revision: successor.revision })
        expect((yield* api.get(initial))?.phase).toBe("joined")
        expect((yield* api.get(successor))?.phase).toBe("terminal")
      }),
    ),
  )
})

test("committed outcome survives cold readback without reconstructing original writers", async () => {
  await using fixture = await tmpdir()
  const file = `${fixture.path}/outcomes.db`
  const retained = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* make(yield* Database.Service)
        const token = yield* api.admit(initial)
        yield* api.observe(token, terminal)
        yield* api.joined(token, terminal)
        // Deliberately drop the settlement receipt, then read committed original rows.
        return { api, token, receipt: yield* api.get(initial) }
      }),
    ),
    file,
  )
  expect((await Effect.runPromise(retained.api.joined(retained.token, terminal).pipe(Effect.exit)))._tag).toBe(
    "Failure",
  )
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* make(yield* Database.Service)
        expect(yield* api.get(initial)).toEqual(retained.receipt)
        expect((yield* api.observe(retained.token, terminal).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* api.admit(initial).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    ),
    file,
  )
})

test("bounded evidence and corrupted stored scalar refuse before outcome adoption", async () => {
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const api = yield* make(database)
        expect((yield* api.admit({ ...initial, origins: [undefined] }).pipe(Effect.exit))._tag).toBe("Failure")
        const token = yield* api.admit(initial)
        expect(
          (yield* api.observe(token, { ...terminal, output: "x".repeat(256 * 1024) }).pipe(Effect.exit))._tag,
        ).toBe("Failure")
        expect((yield* api.get(initial))?.phase).toBe("admitted")
        yield* api.observe(token, terminal)
        yield* database.db
          .update(Table)
          .set({ terminalSHA: "f".repeat(64) })
          .where(eq(Table.id, initial.id))
          .run()
        expect((yield* api.get(initial).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* api.joined(token, terminal).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    ),
  )
})

for (const mode of ["completed", "cancelled", "error", "mismatch", "fiber", "retirement"] as const) {
  test(`original external observer ${mode} retains truthful joined or debt evidence`, async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* make(yield* Database.Service)
          const scope = yield* Scope.Scope
          const owned = yield* Scope.make()
          const retirement = yield* Deferred.make<Exit.Exit<void>>()
          const control = yield* Invocation.make(initial.origins[0])
          const producer = yield* Observer.slot(control.join, control.request)
          const generation = yield* Observer.enroll(api, initial, [producer], retirement)
          if (!generation) throw new Error("Owned generation unavailable")
          if (mode === "retirement")
            yield* Effect.addFinalizer(() => Effect.die(new Error("original cleanup failure"))).pipe(
              Effect.provideService(Scope.Scope, owned),
            )
          const work =
            mode === "cancelled"
              ? Effect.never
              : mode === "completed"
                ? Effect.succeed(terminal.output)
                : Effect.fail(new Error("original worker failure"))
          const body = control.run(work)
          const fiber = yield* (mode === "fiber" ? body : body.pipe(Effect.catchCause(() => Effect.void))).pipe(
            Effect.ensuring(Deferred.succeed(control.joined, undefined)),
            Effect.forkIn(owned, { startImmediately: true }),
          )
          yield* Observer.attach(producer, fiber)
          const outcome =
            mode === "completed"
              ? terminal
              : mode === "cancelled"
                ? { ...initial, status: "cancelled" as const, completed_at: 2 }
                : {
                    ...initial,
                    status: "error" as const,
                    completed_at: 2,
                    error: mode === "mismatch" ? "different failure" : "original worker failure",
                  }
          const observer = yield* Observer.observe(generation, outcome, scope)
          if (!observer) throw new Error("Original external observer unavailable")
          yield* Observer.retire(
            generation,
            Scope.close(owned, Exit.void).pipe(Effect.onExit((exit) => Deferred.succeed(retirement, exit))),
          ).pipe(Effect.exit)
          expect(Exit.isSuccess(yield* Fiber.await(observer))).toBe(true)
          expect((yield* api.get(initial))?.phase).toBe(
            mode === "completed" || mode === "cancelled" || mode === "error" ? "joined" : "terminal",
          )
          expect((yield* api.get(initial))?.terminal?.status).toBe(outcome.status)
        }),
      ),
    )
  })
}

test("unowned retirement delegates the original close and preserves its failure", async () => {
  const events: string[] = []
  const err = new Error("original legacy close failure")
  const exit = await Effect.runPromise(
    Observer.retire(undefined, Effect.sync(() => events.push("close")).pipe(Effect.andThen(Effect.fail(err)))).pipe(
      Effect.exit,
    ),
  )
  expect(events).toEqual(["close"])
  expect(Exit.isFailure(exit)).toBe(true)
})

test("actual background engine publishes joined only after its original completed producer retires", async () => {
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* make(yield* Database.Service)
        const joined = yield* Deferred.make<void>()
        // Delegate the actual durable write before observing its completion.
        const sink = {
          ...api,
          joined: (token: object, info: BackgroundJob.Info) =>
            api.joined(token, info).pipe(Effect.andThen(Deferred.succeed(joined, undefined))),
        }
        const jobs = yield* BackgroundJob.make.pipe(Effect.provideService(OutcomeService, sink))
        const events: string[] = []
        const info = yield* jobs.start({
          id: initial.id,
          type: initial.type,
          origin: initial.origins[0],
          run: Effect.succeed(terminal.output).pipe(Effect.ensuring(Effect.sync(() => events.push("original exit")))),
        })
        if (!info.revision) throw new Error("Actual engine generation unavailable")
        const result = yield* jobs.wait({ id: info.id })
        expect(result.info?.status).toBe("completed")
        yield* Deferred.await(joined)
        const receipt = yield* api.get({ id: info.id, revision: info.revision })
        expect(events).toEqual(["original exit"])
        expect(receipt?.phase).toBe("joined")
        expect(receipt?.terminal).toEqual(result.info)
        expect(receipt?.terminal?.output).toBe(terminal.output)
      }),
    ),
  )
})

test("actual background engine error cooperatively joins its admitted extension without replay", async () => {
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* make(yield* Database.Service)
        const joined = yield* Deferred.make<void>()
        const sink = {
          ...api,
          joined: (token: object, info: BackgroundJob.Info) =>
            api.joined(token, info).pipe(Effect.andThen(Deferred.succeed(joined, undefined))),
        }
        const jobs = yield* BackgroundJob.make.pipe(Effect.provideService(OutcomeService, sink))
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const events: string[] = []
        const info = yield* jobs.start({
          id: initial.id,
          type: initial.type,
          origin: initial.origins[0],
          run: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail(new Error("original engine worker error"))),
            Effect.ensuring(Effect.sync(() => events.push("first exited"))),
          ),
        })
        if (!info.revision) throw new Error("Actual engine generation unavailable")
        yield* Deferred.await(started)
        expect(
          yield* jobs.extend({
            id: info.id,
            origin: { ...initial.origins[0], callID: "extension-call", childMessageID: "extension-input" },
            run: Effect.sync(() => events.push("extension entered")).pipe(
              Effect.andThen(Effect.never),
              Effect.andThen(Effect.sync(() => events.push("extension replayed"))),
              Effect.as("unexpected extension replay"),
              Effect.ensuring(Effect.sync(() => events.push("extension exited"))),
            ),
          }),
        ).toBe(true)
        const current = yield* jobs.get(info.id)
        if (!current?.revision) throw new Error("Actual extension generation unavailable")
        expect(current.revision).not.toBe(info.revision)
        yield* Deferred.succeed(release, undefined)
        const result = yield* jobs.wait({ id: info.id })
        expect(result.info?.status).toBe("error")
        expect(result.info?.error).toBe("original engine worker error")
        yield* Deferred.await(joined)
        const receipt = yield* api.get({ id: info.id, revision: current.revision })
        expect(receipt?.phase).toBe("joined")
        expect(receipt?.terminal).toEqual(result.info)
        expect(receipt?.identity.origins).toHaveLength(2)
        expect((yield* api.get({ id: info.id, revision: info.revision }))?.phase).toBe("admitted")
        expect(events.filter((event) => event === "first exited")).toHaveLength(1)
        expect(events.filter((event) => event === "extension entered").length).toBeLessThanOrEqual(1)
        expect(events.filter((event) => event === "extension exited").length).toBe(
          events.filter((event) => event === "extension entered").length,
        )
        expect(events).not.toContain("extension replayed")
      }),
    ),
  )
})

test("actual SQL admission failure publishes no producer and leaves an existing generation unchanged", async () => {
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const api = yield* make(database)
        const lineage = yield* Lineage.make
        const joined = yield* Deferred.make<void>()
        const sink = {
          ...api,
          joined: (token: object, info: BackgroundJob.Info) =>
            api.joined(token, info).pipe(Effect.andThen(Deferred.succeed(joined, undefined))),
        }
        const jobs = yield* BackgroundJob.make.pipe(
          Effect.provideService(OutcomeService, sink),
          Effect.provideService(Lineage.Service, lineage),
        )
        const block = database.db.run(sql`
          CREATE TRIGGER refuse_outcome_admission BEFORE INSERT ON raya_background_outcome
          BEGIN SELECT RAISE(ABORT, 'owned admission failure'); END
        `)
        const unblock = database.db.run(sql`DROP TRIGGER refuse_outcome_admission`)
        const events: string[] = []
        yield* block
        const failed = yield* jobs
          .start({
            id: initial.id,
            type: initial.type,
            origin: initial.origins[0],
            run: Effect.sync(() => {
              events.push("refused start ran")
              return "unexpected"
            }),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* jobs.list()).toEqual([])
        expect(lineage.entries.size).toBe(0)
        expect(events).toEqual([])
        yield* unblock
        const release = yield* Deferred.make<void>()
        const info = yield* jobs.start({
          id: initial.id,
          type: initial.type,
          origin: initial.origins[0],
          run: Deferred.await(release).pipe(Effect.as("original success")),
        })
        if (!info.revision) throw new Error("Actual engine generation unavailable")
        expect(lineage.entries.size).toBe(1)
        yield* block
        const extension = yield* jobs
          .extend({
            id: info.id,
            origin: { ...initial.origins[0], callID: "refused-call", childMessageID: "refused-input" },
            run: Effect.sync(() => {
              events.push("refused extension ran")
              return "unexpected"
            }),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(extension)).toBe(true)
        expect(yield* jobs.get(info.id)).toEqual(info)
        expect(lineage.entries.size).toBe(1)
        expect((yield* api.get({ id: info.id, revision: info.revision }))?.phase).toBe("admitted")
        expect(events).toEqual([])
        yield* unblock
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(joined)
        expect((yield* api.get({ id: info.id, revision: info.revision }))?.phase).toBe("joined")
        expect(lineage.entries.size).toBe(0)
        expect(events).toEqual([])
      }),
    ),
  )
})
