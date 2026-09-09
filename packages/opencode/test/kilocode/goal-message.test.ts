import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import * as GoalMessage from "@/kilocode/goal/message"
import { provideTmpdirProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      SessionPrompt.node,
      Database.node,
      EventV2.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

it.live(
  "conditional goal publication rejects duplicates and superseding input without changing event history",
  provideTmpdirProject(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const session = yield* sessions.create({})
        const id = MessageID.ascending()
        const at = Date.now()
        const info = { id, sessionID: session.id, role: "user" as const, agent: "build", model, time: { created: at } }
        const input = { database, events, info, sessionID: session.id, messageID: id, queuedAt: at }
        const before = yield* database.db.select().from(EventTable).all()
        const results = yield* Effect.all([GoalMessage.publish(input), GoalMessage.publish(input)].map(Effect.exit), {
          concurrency: "unbounded",
        })
        expect(results.filter(Exit.isSuccess)).toHaveLength(1)
        expect(results.filter(Exit.isFailure)).toHaveLength(1)
        expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(1)
        expect(yield* database.db.select().from(EventTable).all()).toHaveLength(before.length + 1)
        const reserved = MessageID.ascending()
        yield* sessions.updateMessage({ ...info, id: MessageID.ascending() })
        const saved = yield* sessions.messages({ sessionID: session.id })
        const history = yield* database.db.select().from(EventTable).all()
        const rejected = yield* GoalMessage.publish({
          ...input,
          messageID: reserved,
          info: { ...info, id: reserved },
        }).pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        if (Exit.isFailure(rejected)) expect(Cause.squash(rejected.cause)).toBeInstanceOf(GoalMessage.Conflict)
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual(saved)

        expect(yield* database.db.select().from(EventTable).all()).toEqual(history)
      }),
    { git: true },
  ),
  30_000,
)

it.live(
  "the real no-reply prompt path saves the reserved message once and rejects another insertion",
  provideTmpdirProject(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({})
        const id = MessageID.ascending()
        const input = {
          sessionID: session.id,
          messageID: id,
          goalQueuedAt: Date.now(),
          agent: "build",
          model,
          noReply: true,
          parts: [{ type: "text" as const, text: "Reserved continuation", synthetic: true }],
        }
        const result = yield* prompt.prompt(input)
        expect(result.info.id).toBe(id)
        const saved = yield* sessions.messages({ sessionID: session.id })
        expect(saved).toHaveLength(1)
        expect(saved[0].parts.some((part) => part.type === "text" && part.text === "Reserved continuation")).toBe(true)
        const rejected = yield* prompt.prompt(input).pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
        if (Exit.isFailure(rejected)) expect(Cause.squash(rejected.cause)).toBeInstanceOf(GoalMessage.Conflict)
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual(saved)
        const pending = { ...input, messageID: MessageID.ascending(), goalQueuedAt: Date.now() }
        yield* prompt.prompt({
          ...input,
          messageID: MessageID.ascending(),
          goalQueuedAt: undefined,
          parts: [{ type: "text", text: "New user direction" }],
        })
        const newer = yield* sessions.messages({ sessionID: session.id })
        const stale = yield* prompt.prompt(pending).pipe(Effect.exit)
        expect(Exit.isFailure(stale)).toBe(true)
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual(newer)
      }),
    { git: true, config: { formatter: false, lsp: false, enabled_providers: ["test"] } },
  ),
  30_000,
)
