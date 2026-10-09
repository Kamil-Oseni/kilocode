import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { load } from "@/kilocode/second-brain/capture-turn"
import { extracted, extraction, prepared } from "@/kilocode/second-brain/capture-extraction"
import { RayaChief } from "@/kilocode/chief"
import { remember } from "@/kilocode/second-brain/capture-routing"
import { asSchema } from "ai"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node, Storage.node])),
)

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

it.instance(
  "stored original Auto acknowledgement excludes its restatements without changing source or ordinary provenance",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const text =
        "For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms. I also prefer the Memory tab to be for manually inspecting and adjusting settings. Do not change lights or place orders."
      const reply =
        "I've noted your preference for concise ask cards and manual Memory inspection. I will not proceed with any setup steps."
      const question: Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID"> = { type: "text", text }
      const response: Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID"> = { type: "text", text: reply }
      yield* f.db.update(PartTable).set({ data: question }).where(eq(PartTable.message_id, f.user)).pipe(Effect.orDie)
      yield* f.db
        .update(PartTable)
        .set({ data: response })
        .where(eq(PartTable.message_id, f.assistant))
        .pipe(Effect.orDie)
      yield* f.db
        .update(MessageTable)
        .set({ data: { ...f.reply, agent: "auto" } })
        .where(eq(MessageTable.id, f.assistant))
        .pipe(Effect.orDie)
      yield* f.sessions.setMetadata({
        sessionID: f.session.id,
        metadata: { [RayaChief.requestKey]: text, [RayaChief.phaseKey]: "route" },
      })
      const session = yield* f.sessions.get(f.session.id)
      const original = yield* load(f.session.id, f.assistant, session)
      if (!original) throw new Error("Actual stored original required")
      expect(original.acknowledgement).toBe(true)
      expect(original.source.assistant.text).toBe(reply)
      const ordinary = yield* load(f.session.id, f.assistant)
      expect(ordinary?.acknowledgement).toBe(false)
      expect(ordinary?.source_sha256).toBe(original.source_sha256)
      const rows = JSON.parse(prepared(original.source, original.acknowledgement)) as {
        ref: number
        origin: string
        excluded?: string
      }[]
      const ref = rows.find((row) => row.origin === "assistant_interpretation")!
      expect(ref.excluded).toBe("preference_acknowledgement")
      const output = {
        entries: [
          {
            category: "Preferences",
            key: "restatement",
            text: "Prefers concise ask cards.",
            origin: "assistant_interpretation",
            evidence: [{ ref: ref.ref }],
          },
        ],
        preferences: {
          preference_0: { status: "excluded", reason: "no_durable_fact" },
          preference_2: { status: "excluded", reason: "no_durable_fact" },
        },
      }
      const validated = yield* Effect.promise(
        async () => await asSchema(extraction(original.source, original.acknowledgement)).validate!(output),
      )
      expect(validated.success).toBe(false)
      expect(() => extracted(output, original.source, original.acknowledgement)).toThrow("bounded entry schema")
      expect(extracted(output, original.source)[0].origin).toBe("assistant_interpretation")
      const retained = extracted(
        {
          entries: [],
          preferences: {
            preference_0: {
              status: "retained",
              entry: {
                category: "Preferences",
                key: "cards",
                text: text.slice(0, 94),
                origin: "user_statement",
                evidence: [{ ref: 0 }],
              },
            },
            preference_2: {
              status: "retained",
              entry: {
                category: "Preferences",
                key: "memory",
                text: text.slice(95, 177),
                origin: "user_statement",
                evidence: [{ ref: 2 }],
              },
            },
          },
        },
        original.source,
        original.acknowledgement,
      )
      expect(retained.map((entry) => entry.key)).toEqual(["p0_cards", "p2_memory"])
      expect(retained.map((entry) => entry.evidence)).toEqual([
        [{ id: f.user, start: 0, end: 94 }],
        [{ id: f.user, start: 95, end: 177 }],
      ])
      expect((yield* load(f.session.id, f.assistant, { ...session, parentID: f.session.id }))?.acknowledgement).toBe(
        false,
      )
      yield* f.sessions.setMetadata({
        sessionID: f.session.id,
        metadata: { [RayaChief.requestKey]: "other request", [RayaChief.phaseKey]: "route" },
      })
      expect((yield* load(f.session.id, f.assistant, yield* f.sessions.get(f.session.id)).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      const user = (yield* f.sessions.messages({ sessionID: f.session.id, limit: 64 })).find(
        (row) => row.info.id === f.user,
      )!
      yield* remember(session, user, f.assistant, true)
      const held = yield* f.sessions.get(f.session.id)
      yield* f.sessions.setMetadata({
        sessionID: f.session.id,
        metadata: { ...held.metadata, [RayaChief.requestKey]: "successor", [RayaChief.phaseKey]: "task" },
      })
      const delayed = yield* load(f.session.id, f.assistant, yield* f.sessions.get(f.session.id))
      expect(delayed?.acknowledgement).toBe(true)
      expect(delayed?.source_sha256).toBe(original.source_sha256)
      const storage = yield* Storage.Service
      const paths = yield* storage.list(["raya", "capture-routes"])
      const saved = yield* Effect.forEach(paths, (path) =>
        storage.read<{ assistant: string }>(path).pipe(Effect.map((row) => ({ path, row }))),
      )
      const archive = saved.find((row) => row.row.assistant === f.assistant)!
      for (const row of [
        { user: "other", request: "a".repeat(64), acknowledgement: true },
        { user: f.user, request: "a".repeat(64), acknowledgement: true },
      ]) {
        yield* storage.replace(archive.path, { ...archive.row, ...row })
        expect(
          (yield* load(f.session.id, f.assistant, yield* f.sessions.get(f.session.id)).pipe(Effect.exit))._tag,
        ).toBe("Failure")
      }
    }),
)

it.instance("ordinary Auto interpretation retains its false route after successor metadata", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const part: Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID"> = {
      type: "text",
      text: "The Garden project may need review.",
    }
    yield* f.db.update(PartTable).set({ data: part }).where(eq(PartTable.message_id, f.user)).pipe(Effect.orDie)
    yield* f.db
      .update(MessageTable)
      .set({ data: { ...f.reply, agent: "auto" } })
      .where(eq(MessageTable.id, f.assistant))
      .pipe(Effect.orDie)
    yield* f.sessions.setMetadata({
      sessionID: f.session.id,
      metadata: {
        [RayaChief.requestKey]: part.text,
        [RayaChief.phaseKey]: "route",
        "raya.capture.routes": Object.fromEntries(
          Array.from({ length: 1024 }, (_, index) => [
            `legacy_${index}`,
            { user: f.user, request: "a".repeat(64), acknowledgement: false },
          ]),
        ),
      },
    })
    const session = yield* f.sessions.get(f.session.id)
    const user = (yield* f.sessions.messages({ sessionID: f.session.id, limit: 64 })).find(
      (row) => row.info.id === f.user,
    )!
    yield* remember(session, user, f.assistant, false)
    const held = yield* f.sessions.get(f.session.id)
    expect(held.metadata).toEqual(session.metadata)
    yield* f.sessions.setMetadata({
      sessionID: f.session.id,
      metadata: { ...held.metadata, [RayaChief.requestKey]: "successor", [RayaChief.phaseKey]: "task" },
    })
    expect((yield* load(f.session.id, f.assistant, yield* f.sessions.get(f.session.id)))?.acknowledgement).toBe(false)
    expect((yield* remember(session, user, f.assistant, true).pipe(Effect.exit))._tag).toBe("Success")
    expect((yield* load(f.session.id, f.assistant, yield* f.sessions.get(f.session.id)))?.acknowledgement).toBe(false)
  }),
)

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
