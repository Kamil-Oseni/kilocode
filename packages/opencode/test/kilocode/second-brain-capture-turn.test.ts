import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { load } from "@/kilocode/second-brain/capture-turn"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node])))

const fixture = Effect.gen(function* () {
  yield* seedProject
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Original capture turn" })
  const { db } = yield* Database.Service
  const user = MessageID.ascending()
  const assistant = MessageID.ascending()
  const stamp = Date.parse("2026-10-09T01:30:00Z")
  const model = { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("qwen") }
  const question: Omit<SessionV1.User, "id" | "sessionID"> = {
    role: "user",
    time: { created: stamp },
    agent: "ask",
    model,
  }
  const reply: Omit<SessionV1.Assistant, "id" | "sessionID"> = {
    role: "assistant",
    time: { created: stamp + 1, completed: stamp + 2 },
    parentID: user,
    ...model,
    mode: "ask",
    agent: "ask",
    path: { cwd: session.directory, root: session.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
  const questionpart: Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID"> = {
    type: "text",
    text: "I prefer short spoken replies.",
  }
  const replypart: Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID"> = {
    type: "text",
    text: "I will keep replies brief.",
  }
  yield* db
    .insert(MessageTable)
    .values([
      { id: user, session_id: session.id, time_created: stamp, data: question },
      { id: assistant, session_id: session.id, time_created: stamp + 1, data: reply },
    ])
    .pipe(Effect.orDie)
  yield* db
    .insert(PartTable)
    .values([
      {
        id: PartID.ascending(),
        session_id: session.id,
        message_id: user,
        data: questionpart,
      },
      {
        id: PartID.ascending(),
        session_id: session.id,
        message_id: assistant,
        data: replypart,
      },
    ])
    .pipe(Effect.orDie)
  return { sessions, session, db, user, assistant, stamp, question, reply }
})

it.instance("original capture survives more than 64 successors and rereads changed original bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const original = yield* load(f.session.id, f.assistant)
    expect(original?.source.user.text).toBe("I prefer short spoken replies.")
    const rows = Array.from({ length: 80 }, (_, index) => ({
      id: MessageID.ascending(),
      session_id: f.session.id,
      time_created: f.stamp + 3 + index,
      data: { ...f.question, time: { created: f.stamp + 3 + index } },
    }))
    yield* f.db.insert(MessageTable).values(rows).pipe(Effect.orDie)
    expect(
      (yield* f.sessions.messages({ sessionID: f.session.id, limit: 64 })).some((row) => row.info.id === f.assistant),
    ).toBe(false)
    expect(yield* load(f.session.id, f.assistant)).toEqual(original)
    const changed: Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID"> = {
      type: "text",
      text: "Original source changed.",
    }
    yield* f.db
      .insert(PartTable)
      .values({
        id: PartID.ascending(),
        session_id: f.session.id,
        message_id: f.assistant,
        data: changed,
      })
      .pipe(Effect.orDie)
    expect((yield* load(f.session.id, f.assistant))?.source_sha256).not.toBe(original?.source_sha256)
  }),
)

it.instance("foreign session, missing reply and unfinished original are excluded", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const other = yield* f.sessions.create({ title: "Foreign" })
    expect(yield* load(other.id, f.assistant)).toBeUndefined()
    expect(yield* load(f.session.id, MessageID.ascending())).toBeUndefined()
    const unfinished = { ...f.reply, finish: undefined }
    yield* f.db
      .update(MessageTable)
      .set({ data: unfinished })
      .where(eq(MessageTable.id, f.assistant))
      .pipe(Effect.orDie)
    expect(yield* load(f.session.id, f.assistant)).toBeUndefined()
  }),
)

it.instance("oversized original turn refuses before hydrating a truncated source", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.db
      .update(MessageTable)
      .set({ time_created: f.stamp + 100 })
      .where(eq(MessageTable.id, f.assistant))
      .pipe(Effect.orDie)
    yield* f.db
      .insert(MessageTable)
      .values(
        Array.from({ length: 64 }, (_, index) => ({
          id: MessageID.ascending(),
          session_id: f.session.id,
          time_created: f.stamp + 1 + index,
          data: { ...f.reply, finish: "tool-calls", time: { created: f.stamp + 1 + index } },
        })),
      )
      .pipe(Effect.orDie)
    const result = yield* load(f.session.id, f.assistant).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
  }),
)
