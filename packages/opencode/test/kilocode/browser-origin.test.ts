import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { check } from "@/kilocode/browser/origin"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node])))

const fixture = Effect.gen(function* () {
  yield* seedProject
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Browser origin" })
  const { db } = yield* Database.Service
  const message = MessageID.ascending()
  const id = PartID.ascending()
  const data: Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID"> = {
    type: "tool",
    callID: "origin-call",
    tool: "browser_click",
    state: { status: "pending", input: {}, raw: "" },
  }
  const info: Omit<SessionV1.Assistant, "id" | "sessionID"> = {
    role: "assistant",
    time: { created: 1 },
    parentID: MessageID.ascending(),
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "build",
    agent: "build",
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* db
    .insert(MessageTable)
    .values({
      id: message,
      session_id: session.id,
      data: info,
    })
    .pipe(Effect.orDie)
  yield* db.insert(PartTable).values({ id, session_id: session.id, message_id: message, data }).pipe(Effect.orDie)
  const origin = { sessionID: session.id, messageID: message, callID: data.callID, tool: data.tool }
  return { db, session, message, id, data, origin }
})

it.instance("canonical pending/running origins admit; terminal origins are historical only and unchanged", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    expect(yield* check(f.origin, f.session.directory, false)).toBeUndefined()
    const states: SessionV1.ToolPart["state"][] = [
      f.data.state,
      { status: "running", input: {}, time: { start: 1 } },
      {
        status: "completed",
        input: {},
        output: "private result",
        title: "Done",
        metadata: {},
        time: { start: 1, end: 2 },
      },
      { status: "error", input: {}, error: "Interrupted", time: { start: 1, end: 2 } },
    ]
    for (const state of states) {
      const data: Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID"> = { ...f.data, state }
      yield* f.db.update(PartTable).set({ data }).where(eq(PartTable.id, f.id)).pipe(Effect.orDie)
      const before = yield* f.db.select().from(PartTable).where(eq(PartTable.id, f.id)).get().pipe(Effect.orDie)
      expect(yield* check(f.origin, f.session.directory, true)).toBe(
        state.status === "pending" || state.status === "running" ? f.id : undefined,
      )
      expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBe(f.id)
      expect(yield* f.db.select().from(PartTable).where(eq(PartTable.id, f.id)).get().pipe(Effect.orDie)).toEqual(
        before,
      )
    }
  }),
)

it.instance("missing, changed and foreign ownership refuse without touching canonical rows", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    for (const input of [
      { ...f.origin, sessionID: "ses_missing" },
      { ...f.origin, messageID: MessageID.ascending() },
      { ...f.origin, callID: "different" },
      { ...f.origin, callID: "" },
      { ...f.origin, tool: "browser_type" },
      { ...f.origin, partID: PartID.ascending() },
      { ...f.origin, sessionID: "invalid" },
    ]) {
      expect(yield* check(input, f.session.directory, true)).toBeUndefined()
      expect(yield* check({ partID: f.id, ...input }, f.session.directory, false)).toBeUndefined()
    }
    expect(yield* check({ ...f.origin, partID: f.id }, `${f.session.directory}/other`, false)).toBeUndefined()
    const sessions = yield* Session.Service
    const other = yield* sessions.create({ title: "Other owner" })
    yield* f.db.update(PartTable).set({ session_id: other.id }).where(eq(PartTable.id, f.id)).pipe(Effect.orDie)
    expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBeUndefined()
    yield* f.db.update(PartTable).set({ session_id: f.session.id }).where(eq(PartTable.id, f.id)).pipe(Effect.orDie)
    yield* f.db
      .update(MessageTable)
      .set({ session_id: other.id })
      .where(eq(MessageTable.id, f.message))
      .pipe(Effect.orDie)
    expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBeUndefined()
  }),
)

it.instance("duplicate call IDs refuse even when an exact part ID or only one matching tool is supplied", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const data: Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID"> = {
      type: "tool",
      callID: f.data.callID,
      tool: "browser_type",
      state: { status: "pending", input: {}, raw: "" },
    }
    yield* f.db
      .insert(PartTable)
      .values({
        id: PartID.ascending(),
        message_id: f.message,
        session_id: f.session.id,
        data,
      })
      .pipe(Effect.orDie)
    expect(yield* check(f.origin, f.session.directory, true)).toBeUndefined()
    expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBeUndefined()
  }),
)

it.instance("user messages and malformed tool states refuse historical confirmation", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const before = yield* f.db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.id, f.message))
      .get()
      .pipe(Effect.orDie)
    const info: Omit<SessionV1.User, "id" | "sessionID"> = {
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
    }
    yield* f.db
      .update(MessageTable)
      .set({
        data: info,
      })
      .where(eq(MessageTable.id, f.message))
      .pipe(Effect.orDie)
    expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBeUndefined()
    yield* f.db
      .update(MessageTable)
      .set({ data: before!.data })
      .where(eq(MessageTable.id, f.message))
      .pipe(Effect.orDie)
    // Actual SQLite malformed fixture: schema decoding must refuse rather than trust status alone.
    yield* f.db
      .run(sql`UPDATE part SET data = json_set(data, '$.state', json('{"status":"completed"}')) WHERE id = ${f.id}`)
      .pipe(Effect.orDie)
    expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBeUndefined()
  }),
)

it.instance("deletion and replacement do not resurrect the original historical origin", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.db.delete(PartTable).where(eq(PartTable.id, f.id)).pipe(Effect.orDie)
    expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBeUndefined()
    const id = PartID.ascending()
    yield* f.db
      .insert(PartTable)
      .values({ id, session_id: f.session.id, message_id: f.message, data: f.data })
      .pipe(Effect.orDie)
    expect(yield* check({ ...f.origin, partID: f.id }, f.session.directory, false)).toBeUndefined()
    expect(yield* check(f.origin, f.session.directory, true)).toBe(id)
    yield* f.db.delete(MessageTable).where(eq(MessageTable.id, f.message)).pipe(Effect.orDie)
    expect(yield* check({ ...f.origin, partID: id }, f.session.directory, false)).toBeUndefined()
    expect(yield* f.db.select().from(PartTable).where(eq(PartTable.id, id)).all().pipe(Effect.orDie)).toEqual([])
    yield* f.db.delete(SessionTable).where(eq(SessionTable.id, f.session.id)).pipe(Effect.orDie)
    expect(yield* check(f.origin, f.session.directory, false)).toBeUndefined()
  }),
)
