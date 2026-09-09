import { expect, test } from "bun:test"
import { Context, Effect, Exit, Layer } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { tmpdir } from "../fixture/fixture"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, filename = ":memory:") =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(filename))))

test("retirement persists across reopening without changing active, current or unrelated work", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, "retirement.sqlite")
  const ids = await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const queue = RayaTaskQueue.make(database)
        for (const agentID of ["routine", "another"]) {
          for (const version of [1, 2, 3]) {
            yield* queue.publish({
              agentID,
              version,
              occurrences: [1000, 2000, 3000].map((at) => ({ at, observedAt: 4000 })),
            })
          }
        }
        const rows = yield* queue.pending("routine", 1)
        for (const row of rows.slice(0, 2)) {
          yield* queue.claim({ id: row.id, claimID: row.id, owner: "backend", now: 4000, until: 5000 })
        }
        yield* queue.link({ id: rows[1].id, claimID: rows[1].id, sessionID: "session", now: 4001 })
        yield* queue.retire("routine", 2)
        return rows.map((row) => row.id)
      }),
    ),
    filename,
  )
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const queue = RayaTaskQueue.make(database)
        expect((yield* queue.get(ids[0]))?.state).toBe("starting")
        expect((yield* queue.get(ids[1]))?.session_id).toBe("session")
        expect((yield* queue.get(ids[1]))?.state).toBe("linked")
        const retired = yield* queue.get(ids[2])
        expect(retired?.state).toBe("skipped")
        expect(retired?.reason).toBe("Replaced by a newer schedule version.")
        yield* queue.retire("routine", 2)
        expect(yield* queue.get(ids[2])).toEqual(retired)
        expect(yield* queue.pending("routine", 2)).toHaveLength(3)
        expect(yield* queue.pending("routine", 3)).toHaveLength(3)
        expect(yield* queue.pending("another", 1)).toHaveLength(3)
        expect((yield* queue.cursor("routine", 1))?.through).toBe(3000)
        const current = (yield* queue.pending("routine", 2))[0]
        yield* queue.discard("routine")
        expect((yield* queue.get(ids[0]))?.state).toBe("starting")
        expect((yield* queue.get(ids[1]))?.state).toBe("linked")
        expect(yield* queue.get(ids[2])).toEqual(retired)
        expect(yield* queue.pending("routine", 2)).toEqual([])
        expect(yield* queue.pending("routine", 3)).toEqual([])
        expect((yield* queue.get(current.id))?.reason).toBe("Routine removed from the roster.")
        expect(yield* queue.pending("another", 1)).toHaveLength(3)
      }),
    ),
    filename,
  )
}, 30_000)

test("publishes occurrences and a cursor atomically, rejecting stale publishers", async () => {
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const queue = RayaTaskQueue.make(database)
        const batch = {
          agentID: "routine",
          version: 1,
          occurrences: [
            { at: 1000, observedAt: 3000 },
            { at: 2000, observedAt: 3000, tz: "UTC" },
          ],
        }
        expect(yield* queue.publish(batch)).toBe(2000)
        expect((yield* queue.cursor("routine", 1))?.through).toBe(2000)
        expect((yield* queue.pending("routine", 1)).map((row) => row.scheduled_at)).toEqual([1000, 2000])
        expect((yield* queue.publish(batch).pipe(Effect.flip))._tag).toBe("RayaTaskQueue.Conflict")
        expect((yield* queue.publish({ ...batch, expected: 2000 }).pipe(Effect.flip))._tag).toBe(
          "RayaTaskQueue.Conflict",
        )
        expect(yield* queue.publish({ ...batch, version: 2 })).toBe(2000)
        expect(yield* queue.pending("routine", 2)).toHaveLength(2)
        expect(yield* queue.pending("another", 1)).toEqual([])
      }),
    ),
  )
})

test("rolls back earlier inserts and the cursor if a later occurrence fails", async () => {
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const queue = RayaTaskQueue.make(database)
        const result = yield* queue
          .publish({
            agentID: "routine",
            version: 1,
            occurrences: [
              { at: 1000, observedAt: 3000 },
              { at: 2000, observedAt: 1999 },
            ],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* queue.pending("routine", 1)).toEqual([])
        expect(yield* queue.cursor("routine", 1)).toBeUndefined()
        expect(
          yield* queue.publish({
            agentID: "routine",
            version: 1,
            occurrences: [
              { at: 1000, observedAt: 3000 },
              { at: 1000, observedAt: 4000 },
            ],
          }),
        ).toBe(1000)
        const rows = yield* queue.pending("routine", 1)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.observed_at).toBe(3000)
      }),
    ),
  )
})

test("claim ownership fences linking, heartbeat and settlement; expiry only reports stale work", async () => {
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const queue = RayaTaskQueue.make(database)
        yield* queue.publish({ agentID: "routine", version: 1, occurrences: [{ at: 1000, observedAt: 2000 }] })
        const row = (yield* queue.pending("routine", 1))[0]
        const owner = { id: row.id, claimID: "claim", owner: "backend-a", now: 2000, until: 3000 }
        expect((yield* queue.claim(owner))?.state).toBe("starting")
        expect(yield* queue.claim({ ...owner, claimID: "other" })).toBeUndefined()
        expect(yield* queue.pending("routine", 1)).toEqual([])
        expect(yield* queue.heartbeat({ ...owner, owner: "backend-b", until: 4000 })).toBe(false)
        expect(yield* queue.heartbeat({ ...owner, until: 2500 })).toBe(false)
        expect(yield* queue.heartbeat({ ...owner, now: 2500, until: 4000 })).toBe(true)
        expect(yield* queue.stale(3999)).toEqual([])
        expect((yield* queue.stale(4000)).map((item) => item.id)).toEqual([row.id])
        expect(yield* queue.heartbeat({ ...owner, now: 4000, until: 5000 })).toBe(false)
        expect(yield* queue.claim({ ...owner, claimID: "replacement", now: 4000, until: 5000 })).toBeUndefined()
        const link = { id: row.id, claimID: "claim", sessionID: "session", now: 4001 }
        expect(yield* queue.link({ ...link, claimID: "other" })).toBe(false)
        expect(yield* queue.link(link)).toBe(true)
        expect(yield* queue.link({ ...link, sessionID: "replacement" })).toBe(false)
        expect(yield* queue.settle({ ...link, sessionID: "replacement" })).toBe(false)
        expect(yield* queue.settle(link)).toBe(true)
        expect((yield* queue.get(row.id))?.state).toBe("complete")
        expect(yield* queue.stale(5000)).toEqual([])
      }),
    ),
  )
})

test("independent database connections have one publisher and one claim winner, and reopen preserves them", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, "queue.sqlite")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = RayaTaskQueue.make(
          Context.get(yield* Layer.build(Database.layerFromPath(filename)), Database.Service),
        )
        const second = RayaTaskQueue.make(
          Context.get(yield* Layer.build(Database.layerFromPath(filename)), Database.Service),
        )
        const input = { agentID: "routine", version: 1, occurrences: [{ at: 1000, observedAt: 2000 }] }
        const writes = yield* Effect.all(
          [first.publish(input).pipe(Effect.exit), second.publish(input).pipe(Effect.exit)],
          { concurrency: 2 },
        )
        expect(writes.filter(Exit.isSuccess)).toHaveLength(1)
        const row = (yield* first.pending("routine", 1))[0]
        const lease = { id: row.id, owner: "backend", now: 2000, until: 3000 }
        const claims = yield* Effect.all(
          [first.claim({ ...lease, claimID: "first" }), second.claim({ ...lease, claimID: "second" })],
          { concurrency: 2 },
        )
        expect(claims.filter(Boolean)).toHaveLength(1)
      }),
    ),
  )
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const queue = RayaTaskQueue.make(database)
        expect((yield* queue.cursor("routine", 1))?.through).toBe(1000)
        expect(yield* queue.pending("routine", 1)).toEqual([])
        const stale = yield* queue.stale(3000)
        expect(stale).toHaveLength(1)
        expect(stale[0]?.state).toBe("starting")
        expect(stale[0]?.claim_id).toMatch(/^(first|second)$/)
      }),
    ),
    filename,
  )
}, 30_000)
