import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
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
import path from "node:path"
import { createHash } from "node:crypto"
import { retain } from "@/kilocode/second-brain/capture-decisions"
import { identity } from "@/kilocode/second-brain/capture-source"
import { stage } from "@/kilocode/second-brain/capture-phase"
import { CaptureRejected } from "@/kilocode/second-brain/capture-errors"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Schema } from "effect"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Database.node,
      Storage.node,
      FSUtil.node,
      Git.node,
      CrossSpawnSpawner.node,
    ]),
  ),
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

it.instance("stored FA29 stated preference keeps its exact fact separate from acknowledgement instructions", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const fact = "My stated voice preference is a turn-taking conversation without automatic interruption."
    const request = "Please just acknowledge that in one sentence."
    const text = `${fact} ${request}`
    yield* f.db
      .update(PartTable)
      .set({ data: { type: "text", text } })
      .where(eq(PartTable.message_id, f.user))
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
    const original = yield* load(f.session.id, f.assistant, yield* f.sessions.get(f.session.id))
    if (!original) throw new Error("Stored original capture required")
    expect(original.acknowledgement).toBe(true)
    expect(original.source.user.text).toBe(text)
    expect((yield* load(f.session.id, f.assistant))?.source_sha256).toBe(original.source_sha256)
    const rows = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          ref: Schema.Int,
          text: Schema.String,
          slot: Schema.optional(Schema.String),
          excluded: Schema.optional(Schema.String),
        }),
      ),
    )(JSON.parse(prepared(original.source, original.acknowledgement)))
    expect(rows.find((row) => row.slot)?.text).toBe(fact)
    expect(rows.find((row) => row.text === request)?.excluded).toBe("acknowledgement_request")
    const excluded = { entries: [], preferences: { preference_0: { status: "excluded", reason: "no_durable_fact" } } }
    expect(extracted(excluded, original.source, original.acknowledgement)).toEqual([])
    const value = {
      entries: [],
      preferences: {
        preference_0: {
          status: "retained",
          entry: {
            category: "Preferences",
            key: "turn_taking",
            text: "Prefers uninterrupted turn-taking.",
            origin: "user_statement",
            evidence: [{ ref: 0 }],
          },
        },
      },
    }
    const result = extracted(value, original.source, original.acknowledgement)
    expect(result[0].evidence).toEqual([{ id: f.user, start: 0, end: fact.length }])
    expect(result[0].text).toBe(`Prefers uninterrupted turn-taking.\n\nOriginal user preference: ${fact}`)
    expect((yield* load(f.session.id, f.assistant))?.source_sha256).toBe(original.source_sha256)
  }),
)

for (const mode of ["source_changed", "grant_expired"] as const)
  it.instance(`actual retained decision cannot dispatch after original ${mode}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const original = yield* load(f.session.id, f.assistant)
      if (!original) throw new Error("Actual stored source required")
      const cfg = {
        id: identity(f.session.directory, f.session.id, f.assistant),
        grantSHA: createHash("sha256").update("private-grant-not-stored").digest("hex"),
        project: f.session.directory,
        session: f.session.id,
        assistant: f.assistant,
        user: f.user,
        source_sha256: original.source_sha256,
        model: "local/model+variant",
      }
      const value = {
        entries: [],
        preferences: {
          preference_0: {
            status: "retained",
            entry: {
              category: "Preferences",
              key: "short",
              text: "Prefers short replies.",
              origin: "user_statement",
              evidence: [{ ref: 0 }],
            },
          },
        },
      }
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const current = Effect.gen(function* () {
          // This real source observation runs only after immutable Storage.create.
          expect(yield* storage.readBounded(["raya", "capture-decisions", cfg.id], 16384)).toMatchObject({
            source_sha256: original.source_sha256,
            scope: "preparation_observation_only",
            publication: false,
          })
          if (mode === "source_changed")
            yield* f.db
              .update(PartTable)
              .set({ data: { type: "text", text: "I prefer longer replies." } })
              .where(eq(PartTable.message_id, f.user))
              .pipe(Effect.orDie)
          if (mode === "grant_expired") yield* Effect.sleep(5)
          return yield* load(f.session.id, f.assistant)
        })
        const events: string[] = []
        const result = yield* stage(
          retain(
            cfg,
            value,
            original.source,
            original.observed_utc,
            current,
            Date.now() + (mode === "grant_expired" ? 1 : 30000),
            original.acknowledgement,
          ),
          () => Effect.sync(() => events.push("captureFailed")),
          () => Effect.sync(() => events.push("capture")),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) throw new Error("Original guard failure required")
        const err = Cause.squash(result.cause)
        expect(err).toBeInstanceOf(CaptureRejected)
        expect(err instanceof CaptureRejected ? err.reason : undefined).toBe(mode)
        expect(events).toEqual(["captureFailed"])
        expect(yield* storage.readBounded(["raya", "capture-decisions", cfg.id], 16384)).toMatchObject({
          source_sha256: original.source_sha256,
          count: 1,
          publication: false,
          indexConfirmed: false,
          replay: false,
        })
        const after = yield* load(f.session.id, f.assistant)
        expect(after?.source_sha256 === original.source_sha256).toBe(mode !== "source_changed")
      }).pipe(Effect.provide(Storage.layerWithDatabase(path.join(f.session.directory, "decision-storage"))))
    }),
  )
