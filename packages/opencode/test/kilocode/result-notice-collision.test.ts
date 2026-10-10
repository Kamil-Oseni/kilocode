import { expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { ResultNotice } from "@opencode-ai/core/kilocode/result-notice.sql"
import * as Projection from "@opencode-ai/core/kilocode/result-notice"
import { Committed } from "@opencode-ai/schema/kilocode/result-notice"
import * as Receipts from "@/kilocode/chief/notice-receipt"
import { tmpdir } from "../fixture/fixture"

const payload = Schema.decodeUnknownSync(Committed.data)({
  sessionID: "ses_notice_root",
  info: {
    id: "msg_notice",
    sessionID: "ses_notice_root",
    role: "user",
    agent: "auto",
    model: { providerID: "test", modelID: "test" },
    time: { created: 2 },
  },
  part: {
    id: "prt_notice",
    sessionID: "ses_notice_root",
    messageID: "msg_notice",
    type: "text",
    text: "original bounded completion notice",
    synthetic: true,
  },
  time: 2,
})

// These projection tests exercise SQL atomicity and collisions. Their data-only
// receipt does not claim a genuine producer or authorize a cold continuation.
const receipt = Receipts.schema.parse({
  version: 1,
  root: {
    sessionID: payload.sessionID,
    userID: "msg_original",
    sha: "a".repeat(64),
    authority: "b".repeat(64),
    current: "msg_original",
    route: { messageID: "msg_route", partID: "prt_route", callID: "route-call" },
  },
  row: { messageID: payload.info.id, sha: "c".repeat(64) },
  job: {
    id: "ses_child",
    revision: "original-revision",
    callID: "task-call",
    inputID: "msg_child_input",
    identitySHA: "d".repeat(64),
    terminalSHA: "e".repeat(64),
  },
  source: {
    task: "f".repeat(64),
    child: "a".repeat(64),
    input: "b".repeat(64),
    terminal: "c".repeat(64),
    reads: [],
  },
})

const snapshot = (database: Database.Interface) =>
  Effect.gen(function* () {
    return {
      messages: yield* database.db.select().from(MessageTable).all(),
      parts: yield* database.db.select().from(PartTable).all(),
      receipts: yield* database.db.select().from(ResultNotice).all(),
      events: yield* database.db.select().from(EventTable).all(),
      sequences: yield* database.db.select().from(EventSequenceTable).all(),
    }
  })

const setup = (dir: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`
    INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
    VALUES ('notice-project', ${dir}, 1, 1, '[]')
  `)
    for (const id of ["ses_notice_root", "ses_notice_foreign"])
      yield* database.db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${id}, 'notice-project', ${id}, ${dir}, 'Owned collision fixture', 'test', 1, 1)
    `)
    return database
  })

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | EventV2.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Projection.layer),
      Effect.provide(EventV2.layerWith()),
      Effect.provide(Database.layerFromPath(":memory:")),
      Effect.scoped,
    ),
  )

for (const collision of ["message", "part"] as const) {
  test(`atomic notice refuses a global foreign ${collision} ID without changing rows or committing receipt`, async () => {
    await using fixture = await tmpdir()
    await run(
      Effect.gen(function* () {
        const database = yield* setup(fixture.path)
        const events = yield* EventV2.Service
        const foreign = collision === "message" ? payload.info.id : "msg_foreign"
        yield* database.db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (${foreign}, 'ses_notice_foreign', 1, 1, ${JSON.stringify({ role: "user", time: { created: 1 }, private: "foreign original" })})
      `)
        if (collision === "part")
          yield* database.db.run(sql`
          INSERT INTO part (id, session_id, message_id, time_created, time_updated, data)
          VALUES (${payload.part.id}, 'ses_notice_foreign', ${foreign}, 1, 1, ${JSON.stringify({ type: "text", text: "foreign original part" })})
        `)
        const before = yield* snapshot(database)
        const records = Receipts.make(database)
        const result = yield* events
          .publish(Committed, payload, { commit: () => records.insert(receipt) })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* snapshot(database)).toEqual(before)
      }),
    )
  })
}

test("same-context identical notice replay preserves data; changed same-ID message or part refuses atomically", async () => {
  await using fixture = await tmpdir()
  await run(
    Effect.gen(function* () {
      const database = yield* setup(fixture.path)
      const events = yield* EventV2.Service
      const records = Receipts.make(database)
      yield* events.publish(Committed, payload, { commit: () => records.insert(receipt) })
      const original = yield* snapshot(database)
      const event = original.events[0]
      if (!event) throw new Error("Original notice event is unavailable")
      // Remove only event replay bookkeeping; retained projected rows and the local
      // receipt remain. This forces real replay through the collision-aware projector.
      yield* events.remove(payload.sessionID)
      yield* events.replay({
        id: event.id,
        type: event.type,
        seq: event.seq,
        aggregateID: event.aggregate_id,
        data: event.data,
      })
      expect(yield* snapshot(database)).toEqual(original)
      for (const changed of [
        { ...payload, info: { ...payload.info, agent: "foreign" } },
        { ...payload, part: { ...payload.part, text: "substituted notice" } },
      ]) {
        const before = yield* snapshot(database)
        const result = yield* events.publish(Committed, changed).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* snapshot(database)).toEqual(before)
      }
    }),
  )
})
