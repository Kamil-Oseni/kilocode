import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { RayaChief } from "../../src/kilocode/chief"
import { RayaToolModel } from "../../src/kilocode/chief/tool-model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([SessionPrompt.node, SessionProjector.node, Session.node, Agent.node, CrossSpawnSpawner.node]),
  ),
)
afterEach(disposeAllInstances)

const ref = { providerID: ProviderV2.ID.make("selection"), modelID: ModelV2.ID.make("good") }
const config = {
  enabled_providers: ["selection"],
  provider: {
    selection: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
      models: {
        good: {
          name: "Compatible",
          tool_call: true,
          limit: { context: 100000, output: 10000 },
          variants: { careful: {} },
        },
        bad: { name: "Incompatible", tool_call: false, limit: { context: 100000, output: 10000 } },
      },
    },
  },
}

for (const item of [
  { name: "configured small model", config: { small_model: "selection/bad" }, reason: "unsupported" },
  {
    name: "explicit Auto override",
    config: { small_model: "selection/good", agent: { auto: { model: "selection/missing" } } },
    reason: "missing",
  },
  { name: "manual variant", config: {}, reason: "variant", variant: "missing" },
] as const) {
  it.live(`Auto refuses ${item.name} before recovering messages or changing routing state`, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          expect((yield* agents.list()).some((agent) => agent.name === "auto")).toBe(true)
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const chat = yield* sessions.create({ title: "Existing work", agent: "auto" })
          yield* sessions.setMetadata({
            sessionID: chat.id,
            metadata: { [RayaChief.phaseKey]: "goal", [RayaChief.requestKey]: "Keep existing work" },
          })
          yield* sessions.setPermission({
            sessionID: chat.id,
            permission: [{ permission: "edit", pattern: "*", action: "deny" }],
          })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "auto",
            model: ref,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: chat.id,
            type: "text",
            text: "Original request",
          })
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: chat.id,
            parentID: user.id,
            agent: "auto",
            mode: "auto",
            modelID: ref.modelID,
            providerID: ref.providerID,
            path: { cwd: chat.directory, root: chat.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const before = yield* sessions.get(chat.id)
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const input = {
            sessionID: chat.id,
            agent: "auto",
            model: ref,
            variant: "variant" in item ? item.variant : "careful",
            parts: [{ type: "text" as const, text: "New draft must remain reviewable" }],
            tools: { edit: true },
          }
          const draft = structuredClone(input)
          const exit = yield* prompt.prompt(input).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause)
            expect(error).toBeInstanceOf(RayaToolModel.SelectionError)
            expect(error).toMatchObject({ reason: item.reason })
          }
          expect(input).toEqual(draft)
          expect(yield* sessions.get(chat.id)).toEqual(before)
          expect(yield* sessions.messages({ sessionID: chat.id })).toEqual(messages)
          expect(yield* sessions.children(chat.id)).toEqual([])
        }),
      { config: { ...config, ...item.config } },
    ),
  )
}

it.live("implicit non-Kilo Auto retains the exact parent model, variant and authored request", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Retained choice", agent: "auto" })
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "auto",
          model: ref,
          variant: "careful",
          noReply: true,
          parts: [{ type: "text", text: "Review the design without implementing" }],
        })
        expect(result.info.role).toBe("user")
        if (result.info.role === "user") expect(result.info.model).toEqual({ ...ref, variant: "careful" })
        expect(RayaChief.parent((yield* sessions.get(chat.id)).metadata)).toEqual({ ...ref, variant: "careful" })
        expect(RayaChief.request((yield* sessions.get(chat.id)).metadata)).toBe(
          "Review the design without implementing",
        )
      }),
    { config },
  ),
)

for (const choice of [
  { modelID: ModelV2.ID.make("bad"), reason: "unsupported" },
  { modelID: ModelV2.ID.make("good"), variant: "missing", reason: "variant" },
]) {
  it.live(`Auto continuation refuses persisted ${choice.reason} selection before recovering prior work`, () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const chat = yield* sessions.create({ title: "Retained continuation", agent: "auto" })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "auto",
            model: { ...ref, ...choice },
            time: { created: Date.now() },
          })
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: chat.id,
            parentID: user.id,
            agent: "auto",
            mode: "auto",
            modelID: choice.modelID,
            providerID: ref.providerID,
            path: { cwd: chat.directory, root: chat.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const before = yield* sessions.get(chat.id)
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const exit = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit))
            expect(Cause.squash(exit.cause)).toMatchObject({
              _tag: "RayaModelSelectionError",
              reason: choice.reason,
            })
          expect(yield* sessions.get(chat.id)).toEqual(before)
          expect(yield* sessions.messages({ sessionID: chat.id })).toEqual(messages)
          expect(yield* sessions.children(chat.id)).toEqual([])
        }),
      { config: { ...config, small_model: "selection/good", agent: { auto: { model: "selection/good" } } } },
    ),
  )
}
