import { afterAll, expect } from "bun:test"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { Storage } from "@/storage/storage"
import { RayaGoal } from "@/kilocode/goal"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { goalTools } from "@/kilocode/tool/goal"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { MessageID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const requests: Record<string, unknown>[] = []
const state = { phase: 0, file: "", fresh: false, queued: false }
const endpoint = Bun.serve({
  port: 0,
  async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/chat")
    const body = await request.json()
    requests.push(body)
    const phase = state.phase++
    const previous = body.messages.findLast(
      (row: { role: string; content: string }) => row.role === "tool" && row.content.includes("GATE_REAL_FILE"),
    )
    const content =
      phase === 0
        ? { kind: "tool", name: "create_goal", arguments: { objective: "Read the fixture" } }
        : phase === 1 || (state.queued && phase === 4) || (state.fresh && phase === 6)
          ? { kind: "tool", name: "read", arguments: { filePath: state.file } }
          : phase === 2
            ? {
                kind: "tool",
                name: "update_goal",
                arguments: {
                  status: "complete",
                  requirements: [
                    {
                      requirement: "Read the fixture",
                      passed: true,
                      evidence: [{ callID: JSON.parse(previous.content).toolCallId, summary: "Actual file read" }],
                    },
                  ],
                },
              }
            : undefined
    const text = content
      ? JSON.stringify(content)
      : body.format
        ? JSON.stringify({ kind: "text", content: "DONE" })
        : "DONE"
    return new Response(
      [
        { model: body.model, message: { role: "assistant", content: text }, done: false },
        { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 8, eval_count: 3 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    )
  },
})
process.env.RAYA_ENVELOPE_TEST_ORIGIN = endpoint.url.origin
afterAll(async () => {
  await endpoint.stop(true)
  delete process.env.RAYA_ENVELOPE_TEST_ORIGIN
  await disposeAllInstances()
})
const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: true, experimentalEventSystem: true }),
  deps: [],
})
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionPrompt.node,
      SessionProjector.node,
      Storage.node,
      FSUtil.node,
      Provider.node,
      RuntimeFlags.node,
      Truncate.node,
      Agent.node,
      Config.node,
      Permission.node,
      MCP.node,
      Plugin.node,
      ToolRegistry.node,
      SessionProcessor.node,
      CrossSpawnSpawner.node,
      Database.node,
      EventV2Bridge.node,
    ]),
    [[RuntimeFlags.node, flags]],
  ),
)
it.instance(
  "accepted original goal dispatch synthesizes without tools and new user input remains usable",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const storage = yield* Storage.Service
      const instance = yield* TestInstance
      const goals = RayaGoal.make({ storage, sessions })
      state.file = path.join(instance.directory, "gate.txt")
      yield* Effect.promise(() => writeFile(state.file, "GATE_REAL_FILE", "utf8"))
      const created = yield* sessions.create({ title: "Goal completion gate" })
      const turn = (text: string) =>
        prompt.prompt({
          sessionID: created.id,
          agent: "gate",
          model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("fixture") },
          parts: [{ type: "text", text }],
        })
      yield* turn("Create a goal, read the fixture, complete it and provide DONE")
      const saved = yield* goals.get(created.id)
      expect(saved?.status).toBe("complete")
      expect(saved?.auditAttempt?.accepted).toBe(true)
      expect(saved?.dispatch?.messageID).toBeDefined()
      if (!saved?.dispatch?.messageID) throw new Error("Actual goal dispatch missing")
      const definition = yield* goalTools(goals).update.pipe(Effect.flatMap(Tool.init))
      const check = yield* GoalGate.prepare(definition.jsonSchema, created.id, saved.dispatch.messageID, () =>
        sessions.messages({ sessionID: created.id }).pipe(
          Effect.map((rows) => rows.findLast((row) => row.info.role === "user")?.info.id),
          Effect.orDie,
        ),
      )
      expect(yield* check()).toBe(true)
      expect(requests).toHaveLength(4)
      expect(requests[3]?.tools).toBeUndefined()
      expect(requests[3]?.format).toBeUndefined()
      const tools = (yield* sessions.messages({ sessionID: created.id }))
        .flatMap((row) => row.parts)
        .filter((row) => row.type === "tool")
      expect(tools.map((row) => row.tool)).toEqual(["create_goal", "read", "update_goal"])
      // Exercise a genuine already queued callback through the original processor,
      // then let SessionPrompt finish the dispatch without retaining its refusal.
      const agents = yield* Agent.Service
      const provider = yield* Provider.Service
      const processors = yield* SessionProcessor.Service
      const agent = yield* agents.get("gate")
      if (!agent) throw new Error("Fixture agent missing")
      const model = yield* provider.getModel(ProviderV2.ID.make("openai"), ModelV2.ID.make("fixture"))
      const messages = yield* sessions.messages({ sessionID: created.id })
      const user = messages.findLast((row) => row.info.role === "user")?.info
      if (!user || user.role !== "user") throw new Error("Actual original user missing")
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        parentID: user.id,
        sessionID: created.id,
        role: "assistant",
        mode: agent.name,
        agent: agent.name,
        cost: 0,
        path: { cwd: instance.directory, root: instance.directory },
        providerID: model.providerID,
        modelID: model.id,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      const processor = yield* processors.create({ assistantMessage: assistant, sessionID: created.id, model })
      const catalog = yield* SessionTools.resolve({
        agent,
        model,
        session: yield* sessions.get(created.id),
        processor,
        messages,
        bypassAgentCheck: false,
        promptOps: {
          cancel: prompt.cancel,
          resolvePromptParts: prompt.resolvePromptParts,
          prompt: (input) => prompt.prompt(input).pipe(Effect.orDie),
        },
        memoryCache: {},
      })
      expect(yield* GoalGate.closed(catalog)).toBe(true)
      state.queued = true
      expect(
        yield* processor.process({
          user,
          agent,
          sessionID: created.id,
          system: [],
          messages: [{ role: "user", content: "A callback was queued before completion." }],
          tools: catalog,
          model,
        }),
      ).toBe("continue")
      yield* prompt.loop({ sessionID: created.id })
      const refusal = (yield* sessions.messages({ sessionID: created.id }))
        .flatMap((row) => row.parts)
        .find((row) => row.type === "tool" && row.messageID === assistant.id)
      expect(refusal?.type === "tool" && refusal.state.status === "error" && refusal.state.error).toContain(
        "dispatch is complete",
      )
      expect(requests[5]?.format).toBeUndefined()
      const synthesis = (yield* sessions.messages({ sessionID: created.id })).at(-1)
      expect(synthesis?.parts.some((row) => row.type === "text" && row.text === "DONE")).toBe(true)
      expect(
        (yield* sessions.messages({ sessionID: created.id })).filter(
          (row) => row.info.role === "assistant" && row.info.error,
        ),
      ).toEqual([])
      state.fresh = true
      yield* turn("New user request: read the fixture again")
      const later = (yield* sessions.messages({ sessionID: created.id }))
        .flatMap((row) => row.parts)
        .filter((row) => row.type === "tool")
      expect(later.map((row) => row.tool)).toEqual(["create_goal", "read", "update_goal", "read", "read"])
      const read = later.at(-1)
      expect(read?.state.status).toBe("completed")
      expect(read?.state.status === "completed" && read.state.output).toContain("GATE_REAL_FILE")
      expect((yield* goals.get(created.id))?.intent).toBe(saved.intent)
      expect(requests[6]?.format).toBeDefined()
      expect(yield* GoalGate.closed(catalog)).toBe(false)
      yield* goals.clear(created.id)
      yield* goals.create(created.id, "A new goal intent")
      expect(yield* check()).toBe(false)
      yield* goals.clear(created.id)
    }),
  {
    config: {
      snapshot: false,
      formatter: false,
      lsp: false,
      enabled_providers: ["openai"],
      provider: {
        openai: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${endpoint.url}v1`,
            localInference: true,
            localInferenceAPI: "ollama",
            localInferenceToolFormat: "completion-envelope-v1",
          },
          models: { fixture: { name: "Gate fixture", limit: { context: 32768, output: 1024 } } },
        },
      },
      permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
      agent: {
        gate: {
          mode: "primary",
          steps: 8,
          permission: { "*": "deny", read: "allow", create_goal: "allow", get_goal: "allow", update_goal: "allow" },
        },
      },
    },
  },
  45000,
)
