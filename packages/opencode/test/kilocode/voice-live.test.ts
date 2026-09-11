import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Git } from "@/git"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { NotFoundError } from "@/storage/storage"
import * as Store from "@/kilocode/voice/openai-store"
import { Storage } from "@/storage/storage"
import { Runner } from "@/effect/runner"
import { observe } from "@/kilocode/effect/observation"
import * as Workers from "@/kilocode/session/task-worker"
import { make } from "@/kilocode/voice/openai"
import type { OpenAICall } from "@/kilocode/voice/openai-protocol"
import type { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const secret = "a".repeat(64)
const session = SessionID.make("ses_openai_voice_live")
type Prompt = Parameters<SessionPrompt.Interface["prompt"]>[0]

function answer(input: Prompt): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: input.sessionID,
      parentID: input.messageID!,
      role: "assistant",
      agent: "code",
      mode: "code",
      time: { created: Date.now(), completed: Date.now() },
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test"),
      finish: "stop",
    },
    parts: [
      { id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "Verified Live result" },
    ],
  }
}

const fixture = (
  root: string,
  model: "gpt-live-1" | "gpt-realtime-2.1" = "gpt-live-1",
  work: SessionPrompt.Interface["prompt"] = (input) => Effect.succeed(answer(input)),
) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    yield* database.db
      .run(
        sql`INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('voice-project', ${root}, 1, 1, '[]')`,
      )
      .pipe(Effect.orDie)
    yield* database.db
      .run(
        sql`INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${session}, 'voice-project', 'voice', ${root}, 'Voice live test', 'test', 1, 1)`,
      )
      .pipe(Effect.orDie)
    const runner = Runner.make<MessageV2.WithParts>(yield* Scope.Scope, {
      onInterrupt: Effect.die("test runtime cancelled"),
    })
    const workers = yield* Workers.make({
      inspect: () => Effect.succeed(observe(runner)),
      requestCancel: (_, id) => runner.requestCancel(id),
    })
    const calls: Prompt[] = []
    const voice = yield* make({
      storage,
      database,
      sessions: {
        get: (id: SessionID) =>
          Effect.gen(function* () {
            const row = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.fail(new NotFoundError({ message: "Test parent missing" }))
            return { id: SessionID.make(row.id), directory: row.directory }
          }),
      },
      workers,
      prompts: {
        prompt: (input: Prompt) =>
          runner.ensureRunning(
            Effect.gen(function* () {
              calls.push(input)
              if (!input.messageID || !(yield* workers.bind(input.sessionID, input.messageID)))
                return yield* Effect.die("cancelled before startup")
              return yield* work(input)
            }).pipe(Effect.orDie, Effect.ensuring(workers.release)),
          ),
      },
    })
    const start = {
      parentSessionID: session,
      providerCallID: crypto.randomUUID(),
      requestID: crypto.randomUUID(),
      model,
    }
    const binding = yield* voice.start(start, secret, root)
    return { voice, binding, start, calls, database, storage }
  })

const settled = (read: Effect.Effect<typeof OpenAICall.Type, unknown>) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 200 })) {
      const call = yield* read
      if (call.status !== "accepted" && call.status !== "running") return call
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("voice receipt did not settle")
  })

function context(generation: string, key: string, sequence: number, text = "Please summarize the current file") {
  return {
    generation,
    context: {
      version: 1 as const,
      delegation: key,
      offset: sequence * 900,
      fragments: [
        {
          id: `frag_${sequence}`,
          speaker: "user" as const,
          text,
          start: 0,
          end: 900,
          sequence,
        },
      ],
      incomplete: true as const,
      omitted: false,
    },
  }
}

it.live(
  "Live duration is immutable, saved after close, and does not reopen work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const receipt = { id: "evt_duration_1", model: "gpt-live-1" as const, seconds: 4 }
        const input = { generation: state.binding.generation, receipt }
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        expect(yield* state.voice.duration(state.binding.id, input, secret, root)).toEqual(receipt)
        expect(yield* state.voice.duration(state.binding.id, input, secret, root)).toEqual(receipt)
        expect(
          Exit.isFailure(
            yield* state.voice
              .duration(state.binding.id, { ...input, receipt: { ...receipt, seconds: 9 } }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.calls).toEqual([])
        const stored = yield* Store.make(state.database, state.storage).read(state.binding.id)
        expect(stored.duration).toEqual(receipt)
        expect(stored.binding.status).toBe("closed")
        expect(JSON.stringify(stored)).not.toContain(secret)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

it.live(
  "Live duration refuses a Realtime binding and a Live binding with the wrong generation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const realtime = yield* fixture(root, "gpt-realtime-2.1")
        const live = yield* fixture(root)
        const receipt = { id: "evt_duration_1", model: "gpt-live-1" as const, seconds: 4 }
        expect(
          Exit.isFailure(
            yield* realtime.voice
              .duration(realtime.binding.id, { generation: realtime.binding.generation, receipt }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* live.voice
              .duration(live.binding.id, { generation: "stale_generation_1", receipt }, secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

it.live(
  "Live delegation admits once, refuses consumed user sequence, and keeps original context",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        const first = context(state.binding.generation, "dlg_1", 1)
        const call = yield* state.voice.delegate(state.binding.id, first, secret, root)
        expect(call.callID).toBe(`liv_${createHash("sha256").update("dlg_1").digest("hex").slice(0, 48)}`)
        expect(call.parentSessionID).toBe(session)
        const done = yield* settled(
          state.voice.get(state.binding.id, call.callID, state.binding.generation, secret, root),
        )
        expect(done.status).toBe("completed")
        expect(done.result?.text).toBe("Verified Live result")
        expect(state.calls).toHaveLength(1)
        const part = state.calls[0].parts[0]
        if (part.type !== "text") throw new Error("expected text prompt")
        expect(part.text).toContain("imperfect transcript evidence")
        expect((yield* state.voice.delegate(state.binding.id, first, secret, root)).id).toBe(call.id)
        expect(state.calls).toHaveLength(1)
        expect(
          Exit.isFailure(
            yield* state.voice
              .delegate(state.binding.id, context(state.binding.generation, "dlg_2", 1), secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const next = yield* state.voice.delegate(
          state.binding.id,
          context(state.binding.generation, "dlg_2", 2, "Follow up on the summary"),
          secret,
          root,
        )
        expect(next.callID).not.toBe(call.callID)
        const later = yield* settled(
          state.voice.get(state.binding.id, next.callID, state.binding.generation, secret, root),
        )
        expect(later.status).toBe("completed")
        expect(state.calls).toHaveLength(2)
        const stored = yield* Store.make(state.database, state.storage).read(state.binding.id)
        expect(stored.liveCursor).toBe(2)
        expect(stored.binding.model).toBe("gpt-live-1")
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)

it.live(
  "closing Live admission keeps duration writable and refuses new delegation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const state = yield* fixture(root)
        yield* state.voice.close(state.binding.id, state.binding.generation, secret, root)
        expect(
          Exit.isFailure(
            yield* state.voice
              .delegate(state.binding.id, context(state.binding.generation, "dlg_1", 1), secret, root)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(state.calls).toEqual([])
        const receipt = { id: "evt_duration_2", model: "gpt-live-1" as const, seconds: 1 }
        expect(
          yield* state.voice.duration(
            state.binding.id,
            { generation: state.binding.generation, receipt },
            secret,
            root,
          ),
        ).toEqual(receipt)
      }).pipe(
        Effect.provide([
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "voice.sqlite")),
        ]),
      )
    }),
  30_000,
)
