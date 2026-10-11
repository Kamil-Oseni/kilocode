import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ChiefRouteTool } from "@/kilocode/tool/chief-route"
import { RayaChief } from "@/kilocode/chief"
import { RayaGoal } from "@/kilocode/goal"
import { goalTools } from "@/kilocode/tool/goal"
import { database, storage } from "./fixtures/effect-profile"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      Database.node,
      SessionProjector.node,
      Agent.node,
      Config.node,
      Provider.node,
      Question.node,
      Permission.node,
      Session.node,
      EventV2Bridge.node,
      Truncate.node,
      Storage.node,
      FSUtil.node,
      Git.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)
const cfg = {
  snapshot: false,
  plugin: [],
  mcp: {},
  enabled_providers: ["local"],
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { baseURL: "http://127.0.0.1:11434/v1" },
      models: { fixture: { name: "fixture" } },
    },
  },
  agent: { generalist: { model: "local/fixture" } },
} satisfies Partial<Config.Info>

it.live("actual persisted Chief routing cannot complete a goal whose target was never written", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const store = yield* Storage.Service
        const target = path.join(dir, "never-written.txt")
        const objective = `Write ${target} and verify the full file with Read.`
        const chat = yield* sessions.create()
        const model = { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") }
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "user",
          agent: "auto",
          model,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: user.id,
          type: "text",
          text: objective,
        })
        yield* sessions.setMetadata({
          sessionID: chat.id,
          metadata: { [RayaChief.requestKey]: objective, [RayaChief.phaseKey]: "route" },
        })
        const goals = RayaGoal.make({ storage: store, sessions })
        const goal = yield* goals.create(chat.id, objective, user.id)
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          parentID: user.id,
          role: "assistant",
          agent: "auto",
          mode: "auto",
          cost: 0,
          path: { cwd: dir, root: dir },
          providerID: model.providerID,
          modelID: model.modelID,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })
        const ctx = {
          sessionID: chat.id,
          messageID: assistant.id,
          callID: "actual-route",
          agent: "auto",
          abort: new AbortController().signal,
          messages: yield* sessions.messages({ sessionID: chat.id }),
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const start = Date.now()
        const tool = yield* (yield* ChiefRouteTool).init()
        const result = yield* tool.execute({ objective, access: "edit", result: "narrative" }, ctx)
        expect(result.metadata.decision?.agent).toBe("generalist")
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: assistant.id,
          type: "tool",
          tool: "chief_route",
          callID: ctx.callID,
          state: {
            status: "completed",
            input: { objective, access: "edit", result: "narrative" },
            output: result.output,
            title: result.title,
            metadata: result.metadata,
            time: { start, end: Date.now() },
          },
        })
        expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
        expect(yield* goals.evidence(chat.id)).toEqual([])
        const update = yield* (yield* goalTools(goals, sessions).update).init()
        const rejected = yield* update.execute(
          {
            status: "complete",
            requirements: [
              {
                requirement: objective,
                passed: true,
                evidence: [{ callID: ctx.callID, summary: "Chief routed the requested file work" }],
              },
            ],
          },
          ctx,
        )
        expect(rejected.title).toBe("Completion audit rejected")
        expect(rejected.output).toContain("not a completed post-goal work or verification tool call")
        expect(rejected.output).toContain("none yet")
        expect(rejected.output).not.toContain('"tool":"chief_route"')
        const current = yield* goals.get(chat.id)
        expect(current?.intent).toBe(goal.intent)
        expect(current?.status).toBe("active")
        expect(current?.auditAttempt?.accepted).toBe(false)
        expect(current?.audit).toBeUndefined()
        const getter = yield* (yield* goalTools(goals, sessions).get).init()
        const inspected = JSON.parse((yield* getter.execute({}, ctx)).output)
        expect(inspected.eligibleEvidence).toEqual([])
        expect(inspected.audit_correction).toBeUndefined()
        expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
        expect(yield* sessions.children(chat.id)).toEqual([])
      }),
    { config: cfg },
  ),
)
