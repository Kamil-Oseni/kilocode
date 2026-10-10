import { expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import {
  RoutineEffectScope as Scopes,
  RoutineEffectParticipant as Participants,
  RoutineEffectCapsule as Capsules,
  RoutineEffectMembership as Memberships,
  RoutineEffectAttempt as Attempts,
  RoutineEffectRevocation as Revocations,
} from "@opencode-ai/core/kilocode/routine-effect.sql"
import { within } from "@/kilocode/task/effect-admission"
import { tmpdir } from "../fixture/fixture"

type Tx = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, file = ":memory:") =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(file))))
const scope = {
  id: "a".repeat(64),
  kind: "run" as const,
  principal: "routine",
  birth: "123",
  generation: "1".repeat(32),
  projection: "b".repeat(64),
}
const owner = {
  id: "2".repeat(32),
  profile: "c".repeat(64),
  protocol: "raya.routine.effect.v1" as const,
  cohort: "d".repeat(64),
  pid: 123,
  birth: "456",
}
const capsule = {
  id: "3".repeat(32),
  participant: owner.id,
  generation: "4".repeat(32),
  run: "run",
  session: "session",
  step: "step",
  owner: "e".repeat(64),
  projection: "f".repeat(64),
  scopes: [{ scope: scope.id, generation: scope.generation }],
}
const attempt = { id: "5".repeat(32), kind: "model" as const, purpose: "model:original", digest: "a".repeat(64) }
const revoke = {
  id: "6".repeat(32),
  scope: scope.id,
  generation: scope.generation,
  projection: scope.projection,
  request: "b".repeat(64),
  reason: "cancel",
}

type Api = Parameters<Parameters<typeof within>[1]>[0]

function fixture(tx: Tx, api: Api) {
  return Effect.gen(function* () {
    yield* api.stageScope(scope)
    yield* api.stageParticipant(owner)
    yield* api.stageCapsule(capsule)
    // Test-only SQL states qualify the state machine, NOT a native process,
    // old-binary exclusion, participating writers or transport authority.
    yield* tx.update(Scopes).set({ state: "active" }).where(eq(Scopes.id, scope.id)).run()
    yield* tx.update(Participants).set({ state: "qualified" }).where(eq(Participants.id, owner.id)).run()
    yield* tx.update(Capsules).set({ state: "active" }).where(eq(Capsules.id, capsule.id)).run()
    return { api, token: yield* api.validate(capsule, owner) }
  })
}

test("inactive rows, forged witnesses and foreign transaction helpers refuse SQL transitions", async () => {
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              yield* api.stageScope(scope)
              yield* api.stageParticipant(owner)
              yield* api.stageCapsule(capsule)
              expect((yield* api.validate(capsule, owner).pipe(Effect.flip))._tag).toBe("RoutineEffect.Refusal")
              yield* tx.update(Scopes).set({ state: "active" }).run()
              yield* tx.update(Participants).set({ state: "qualified" }).run()
              yield* tx.update(Capsules).set({ state: "active" }).run()
              const input = structuredClone(capsule)
              const token = yield* api.validate(input, owner)
              input.owner = "0".repeat(64)
              expect((yield* api.reserve(JSON.parse(JSON.stringify(token)), attempt).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect((yield* within(tx, (other) => other.reserve(token, attempt)).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect(yield* tx.select().from(Attempts).all()).toEqual([])
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
  )
})

test("scope projection and membership CAS remain exact at the consumption boundary", async () => {
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              const { token } = yield* fixture(tx, api)
              yield* tx
                .update(Scopes)
                .set({ projection: "0".repeat(64) })
                .where(eq(Scopes.id, scope.id))
                .run()
              expect((yield* api.reserve(token, attempt).pipe(Effect.flip)).message).toBe(
                "Original effect scope projection changed",
              )
              yield* tx.update(Scopes).set({ projection: scope.projection }).where(eq(Scopes.id, scope.id)).run()
              yield* api.reserve(token, attempt)
              expect((yield* api.start(token, { ...attempt, digest: "0".repeat(64) }).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect((yield* tx.select().from(Attempts).get())?.state).toBe("reserved")
              yield* api.start(token, attempt)
              expect((yield* api.start(token, attempt).pipe(Effect.flip))._tag).toBe("RoutineEffect.Refusal")
              expect(
                (yield* api.reserve(token, { ...attempt, id: "7".repeat(32) }).pipe(Effect.flip)).message,
              ).toContain("replay refused")
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
  )
})

test("revocation retains original debt, prevents restart and permits only exact original settlement", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "effects.sqlite")
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              const { token } = yield* fixture(tx, api)
              yield* api.reserve(token, attempt)
              yield* api.start(token, attempt)
              yield* api.reserve(token, { ...attempt, id: "8".repeat(32), kind: "tool", purpose: "call:1" })
              yield* api.revokeScope(revoke)
              expect((yield* tx.select().from(Attempts).get())?.state).toBe("uncertain")
              expect((yield* api.start(token, attempt).pipe(Effect.flip))._tag).toBe("RoutineEffect.Refusal")
              expect(
                (yield* api.settle(token, { ...attempt, digest: "0".repeat(64) }, "c".repeat(64)).pipe(Effect.flip))
                  ._tag,
              ).toBe("RoutineEffect.Refusal")
              yield* api.settle(token, attempt, "c".repeat(64))
              yield* api.finishRevocation(revoke, "published")
              expect((yield* api.settle(token, attempt, "c".repeat(64)).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
    file,
  )
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              expect((yield* tx.select().from(Attempts).where(eq(Attempts.id, attempt.id)).get())?.receipt).toBe(
                "c".repeat(64),
              )
              expect(
                (yield* tx
                  .select()
                  .from(Attempts)
                  .where(eq(Attempts.id, "8".repeat(32)))
                  .get())?.state,
              ).toBe("uncertain")
              expect((yield* tx.select().from(Revocations).get())?.state).toBe("published")
              expect((yield* api.validate(capsule, owner).pipe(Effect.flip))._tag).toBe("RoutineEffect.Refusal")
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
    file,
  )
})

test("original transaction failure rolls back the revocation and all affected debt", async () => {
  await run(
    Database.Service.use((db) =>
      Effect.gen(function* () {
        yield* db.db.transaction(
          (tx) =>
            within(tx, (api) =>
              Effect.gen(function* () {
                const { token } = yield* fixture(tx, api)
                yield* api.reserve(token, attempt)
              }),
            ),
          { behavior: "immediate" },
        )
        const held: Api[] = []
        const failed = yield* db.db
          .transaction(
            (tx) =>
              within(tx, (api) =>
                Effect.gen(function* () {
                  held.push(api)
                  yield* api.revokeScope(revoke)
                  return yield* Effect.fail("original publication failed")
                }),
              ),
            { behavior: "immediate" },
          )
          .pipe(Effect.flip)
        expect(failed).toBe("original publication failed")
        expect(held).toHaveLength(1)
        const captured = held[0]
        if (!captured) throw new Error("Original SQL witness API was not captured")
        expect((yield* captured.revokeScope(revoke).pipe(Effect.flip)).message).toBe(
          "SQL transaction validation scope is closed",
        )
        expect((yield* db.db.select().from(Scopes).get())?.state).toBe("active")
        expect((yield* db.db.select().from(Capsules).get())?.state).toBe("active")
        expect((yield* db.db.select().from(Attempts).get())?.state).toBe("reserved")
        expect(yield* db.db.select().from(Revocations).all()).toEqual([])
        yield* db.db.transaction(
          (tx) =>
            within(tx, (api) =>
              Effect.gen(function* () {
                expect((yield* api.revokeScope({ ...revoke, generation: "0".repeat(32) }).pipe(Effect.flip))._tag).toBe(
                  "RoutineEffect.Refusal",
                )
                expect(yield* tx.select().from(Revocations).all()).toEqual([])
              }),
            ),
          { behavior: "immediate" },
        )
      }),
    ),
  )
})

test("a token from a different actual SQLite database cannot consume identical rows", async () => {
  await using directory = await tmpdir()
  const first = path.join(directory.path, "first.sqlite")
  const second = path.join(directory.path, "second.sqlite")
  const token = await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              return (yield* fixture(tx, api)).token
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
    first,
  )
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              yield* fixture(tx, api)
              expect((yield* api.reserve(token, attempt).pipe(Effect.flip))._tag).toBe("RoutineEffect.Refusal")
              expect(yield* tx.select().from(Attempts).all()).toEqual([])
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
    second,
  )
})

test("unknown attempt owner or generation refuses SQL validation without adoption", async () => {
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              yield* fixture(tx, api)
              yield* tx
                .insert(Attempts)
                .values({
                  ...attempt,
                  capsule: capsule.id,
                  generation: "0".repeat(32),
                  owner: capsule.owner,
                  state: "reserved",
                  receipt: null,
                })
                .run()
              expect((yield* api.validate(capsule, owner).pipe(Effect.flip)).message).toBe(
                "Unknown effect attempt generation or owner",
              )
              expect((yield* tx.select().from(Attempts).get())?.generation).toBe("0".repeat(32))
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
  )
})

test("a model step retains multiple tool purposes while every original purpose refuses replay", async () => {
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              const { token } = yield* fixture(tx, api)
              const first = { ...attempt, id: "7".repeat(32), kind: "tool" as const, purpose: "call:1" }
              const second = { ...attempt, id: "8".repeat(32), kind: "tool" as const, purpose: "call:2" }
              yield* api.reserve(token, attempt)
              yield* api.reserve(token, first)
              yield* api.reserve(token, second)
              yield* api.start(token, first)
              yield* api.start(token, second)
              expect((yield* api.reserve(token, { ...first, id: "9".repeat(32) }).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect(
                (yield* api.reserve(token, { ...first, id: "a".repeat(32), kind: "mcp" }).pipe(Effect.flip))._tag,
              ).toBe("RoutineEffect.Refusal")
              expect((yield* api.settle(token, { ...first, kind: "mcp" }, "c".repeat(64)).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect(yield* tx.select().from(Attempts).all()).toHaveLength(3)
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
  )
})

test("the same leaked API and witness refuse mutations after actual commit and reopen", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "closed.sqlite")
  const leaked = await run(
    Database.Service.use((db) =>
      db.db.transaction((tx) => within(tx, (api) => fixture(tx, api)), { behavior: "immediate" }),
    ),
    file,
  )
  await run(
    Database.Service.use((db) =>
      Effect.gen(function* () {
        expect((yield* leaked.api.reserve(leaked.token, attempt).pipe(Effect.flip)).message).toBe(
          "SQL transaction validation scope is closed",
        )
        expect((yield* leaked.api.revokeScope(revoke).pipe(Effect.flip)).message).toBe(
          "SQL transaction validation scope is closed",
        )
        expect(yield* db.db.select().from(Attempts).all()).toEqual([])
        expect((yield* db.db.select().from(Scopes).get())?.state).toBe("active")
      }),
    ),
    file,
  )
})

test("committed revocation permits exact SQL debt settlement and cold original receipt readback", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "debt.sqlite")
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              const { token } = yield* fixture(tx, api)
              yield* api.reserve(token, attempt)
              yield* api.start(token, attempt)
              yield* api.revokeScope(revoke)
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
    file,
  )
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              expect((yield* api.validate(capsule, owner).pipe(Effect.flip))._tag).toBe("RoutineEffect.Refusal")
              expect((yield* api.validateDebt(capsule, { ...owner, pid: owner.pid + 1 }).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect(
                (yield* api.validateDebt({ ...capsule, generation: "0".repeat(32) }, owner).pipe(Effect.flip))._tag,
              ).toBe("RoutineEffect.Refusal")
              const token = yield* api.validateDebt(capsule, owner)
              expect(
                (yield* api.reserve(token, { ...attempt, id: "9".repeat(32), purpose: "new" }).pipe(Effect.flip))
                  .message,
              ).toBe("Debt-only SQL witness cannot reserve or start")
              expect((yield* api.start(token, attempt).pipe(Effect.flip)).message).toBe(
                "Debt-only SQL witness cannot reserve or start",
              )
              expect(
                (yield* api.settle(token, { ...attempt, purpose: "foreign" }, "c".repeat(64)).pipe(Effect.flip))._tag,
              ).toBe("RoutineEffect.Refusal")
              expect(
                (yield* api.settle(token, { ...attempt, digest: "0".repeat(64) }, "c".repeat(64)).pipe(Effect.flip))
                  ._tag,
              ).toBe("RoutineEffect.Refusal")
              expect((yield* api.retained(token, attempt)).state).toBe("uncertain")
              // Deliberately drop the returned settlement receipt; commit completes normally.
              // This is cold retained-row readback, not injected physical commit ack failure.
              yield* api.settle(token, attempt, "c".repeat(64))
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
    file,
  )
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              const token = yield* api.validateDebt(capsule, owner)
              const retained = yield* api.retained(token, attempt)
              expect(retained.state).toBe("settled")
              expect(retained.receipt).toBe("c".repeat(64))
              expect((yield* api.retained(token, { ...attempt, purpose: "foreign" }).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect((yield* api.settle(token, attempt, retained.receipt).pipe(Effect.flip))._tag).toBe(
                "RoutineEffect.Refusal",
              )
              expect(yield* tx.select().from(Attempts).all()).toHaveLength(1)
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
    file,
  )
})

test("foreign retained revocation ID refuses before changing the original scope", async () => {
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              yield* fixture(tx, api)
              yield* tx
                .insert(Revocations)
                .values({ ...revoke, generation: "0".repeat(32), state: "requested" })
                .run()
              expect((yield* api.revokeScope(revoke).pipe(Effect.flip)).message).toBe(
                "Original scope revocation already exists",
              )
              expect((yield* tx.select().from(Scopes).get())?.state).toBe("active")
              expect((yield* tx.select().from(Capsules).get())?.state).toBe("active")
              expect((yield* tx.select().from(Revocations).get())?.generation).toBe("0".repeat(32))
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
  )
})

test("actual membership generation mutation refuses consumption without creating an attempt", async () => {
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              const { token } = yield* fixture(tx, api)
              yield* tx
                .update(Memberships)
                .set({ generation: "0".repeat(32) })
                .where(eq(Memberships.capsule, capsule.id))
                .run()
              expect((yield* api.reserve(token, attempt).pipe(Effect.flip)).message).toBe(
                "Original effect scope membership changed",
              )
              expect(yield* tx.select().from(Attempts).all()).toEqual([])
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
  )
})

test("1024 original purposes fit while the 1025th is refused before growth or adoption", async () => {
  await run(
    Database.Service.use((db) =>
      db.db.transaction(
        (tx) =>
          within(tx, (api) =>
            Effect.gen(function* () {
              const { token } = yield* fixture(tx, api)
              const rows = Array.from({ length: 1023 }, (_, index) => ({
                ...attempt,
                id: (index + 1).toString(16).padStart(32, "0"),
                kind: "tool" as const,
                purpose: `call:${index}`,
                capsule: capsule.id,
                generation: capsule.generation,
                owner: capsule.owner,
                state: "reserved" as const,
                receipt: null,
              }))
              for (const index of Array.from({ length: Math.ceil(rows.length / 64) }, (_, index) => index)) {
                yield* tx
                  .insert(Attempts)
                  .values(rows.slice(index * 64, (index + 1) * 64))
                  .run()
              }
              yield* api.reserve(token, attempt)
              expect(yield* tx.select().from(Attempts).all()).toHaveLength(1024)
              const extra = { ...attempt, id: "9".repeat(32), kind: "tool" as const, purpose: "extra" }
              expect((yield* api.reserve(token, extra).pipe(Effect.flip)).message).toBe(
                "Effect attempt roster capacity reached; original debt retained",
              )
              expect(yield* tx.select().from(Attempts).all()).toHaveLength(1024)
              // A nonparticipating direct writer is detected, never adopted or truncated.
              yield* tx
                .insert(Attempts)
                .values({
                  ...extra,
                  capsule: capsule.id,
                  generation: capsule.generation,
                  owner: capsule.owner,
                  state: "reserved",
                  receipt: null,
                })
                .run()
              expect((yield* api.validate(capsule, owner).pipe(Effect.flip)).message).toBe(
                "Unknown effect attempt roster",
              )
              expect(yield* tx.select().from(Attempts).all()).toHaveLength(1025)
            }),
          ),
        { behavior: "immediate" },
      ),
    ),
  )
})

test("interruption joins the original transaction rollback and closes the leaked same API", async () => {
  await run(
    Database.Service.use((db) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<{ api: Api; token: object }>()
        const fiber = yield* db.db
          .transaction(
            (tx) =>
              within(tx, (api) =>
                Effect.gen(function* () {
                  const held = yield* fixture(tx, api)
                  yield* api.reserve(held.token, attempt)
                  yield* Deferred.succeed(entered, held)
                  return yield* Effect.never
                }),
              ),
            { behavior: "immediate" },
          )
          .pipe(Effect.forkChild)
        const leaked = yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        expect((yield* leaked.api.reserve(leaked.token, attempt).pipe(Effect.flip)).message).toBe(
          "SQL transaction validation scope is closed",
        )
        expect(yield* db.db.select().from(Scopes).all()).toEqual([])
        expect(yield* db.db.select().from(Capsules).all()).toEqual([])
        expect(yield* db.db.select().from(Attempts).all()).toEqual([])
      }),
    ),
  )
})
