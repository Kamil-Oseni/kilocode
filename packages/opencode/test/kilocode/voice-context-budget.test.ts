import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolRegistry } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import { SystemPrompt } from "@/session/system"
import { Instruction } from "@/session/instruction"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import { KiloToolSchema } from "@/kilocode/session/tool-schema"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { LazyTools } from "@/kilocode/session/lazy-tools"
import { Permission } from "@/permission"
import { jsonSchema, tool, type Tool as AITool } from "ai"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      ToolRegistry.node,
      SystemPrompt.node,
      Provider.node,
      Plugin.node,
      RuntimeFlags.node,
      Instruction.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

it.live(
  "fits the real primary Voice fixed payload without contacting a model",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const registry = yield* ToolRegistry.Service
          const provider = yield* Provider.Service
          const sys = yield* SystemPrompt.Service
          const instruction = yield* Instruction.Service
          const plugin = yield* Plugin.Service
          const flags = yield* RuntimeFlags.Service
          const model = yield* provider.getModel(
            ProviderV2.ID.make("qwen-local"),
            ModelV2.ID.make("qwen3-raya-32k:latest"),
          )
          const info = yield* provider.getProvider(model.providerID)
          const rows = []
          for (const name of ["voice"]) {
            const agent = yield* agents.get(name)
            if (!agent) throw new Error("Missing genuine agent")
            const items = yield* registry.tools({
              providerID: model.providerID,
              modelID: model.id,
              agent,
            })
            const tools: Record<string, AITool> = Object.fromEntries(
              items.map((item) => [
                item.id,
                tool({
                  description: item.description,
                  inputSchema: jsonSchema(ProviderTransform.schema(model, ToolJsonSchema.fromTool(item))),
                }),
              ]),
            )
            expect(agent.mode).toBe("primary")
            const selected = tools
            const skills = yield* sys.skills(agent)
            const env = yield* sys.environment(model)
            const instructions = yield* instruction.system()
            const mcp = yield* sys.mcp(agent)
            const base = yield* LLMRequestPrep.prepare({
              user: {
                id: MessageID.ascending(),
                sessionID: SessionID.make("ses_voice_budget"),
                role: "user",
                time: { created: Date.now() },
                agent: name,
                model: { providerID: model.providerID, modelID: model.id },
              },
              sessionID: "ses_voice_budget",
              agent,
              model,
              system: [...env, ...instructions, ...(skills ? [skills] : []), ...(mcp ? [mcp] : [])],
              messages: [{ role: "user", content: "Explain the meaning of a checksum in one sentence." }],
              tools: selected,
              provider: info,
              auth: undefined,
              plugin,
              flags,
              isWorkflow: false,
            })
            const schemas = yield* Effect.promise(() => KiloToolSchema.sanitize(base.tools))
            expect(Object.keys(schemas).sort()).toEqual(
              ["discover_tools", "read", "glob", "grep", "question", "ask_options", "webfetch"].sort(),
            )
            const large = yield* LLMRequestPrep.prepare({
              user: {
                id: MessageID.ascending(),
                sessionID: SessionID.make("ses_voice_large"),
                role: "user",
                time: { created: Date.now() },
                agent: name,
                model: { providerID: model.providerID, modelID: model.id },
              },
              sessionID: "ses_voice_large",
              agent,
              model: { ...model, limit: { ...model.limit, context: 131072 } },
              system: [...env, ...instructions, ...(skills ? [skills] : []), ...(mcp ? [mcp] : [])],
              messages: [{ role: "user", content: "Tell me which lights are on." }],
              tools,
              provider: info,
              auth: undefined,
              plugin,
              flags,
              isWorkflow: false,
            })
            expect(Object.keys(large.tools).sort()).toEqual(
              Object.keys(Permission.visibleTools(selected, agent.permission)).sort(),
            )
            expect(base.tools.task).toBeUndefined()
            expect(base.tools.chief_route).toBeUndefined()
            const messages = base.messages.filter((message) => message.role === "system")
            const system = KiloSessionOverflow.measure({ messages, tools: {} }).normalized
            const catalog = KiloSessionOverflow.measure({ messages: [], tools: schemas }).normalized
            const checked = KiloSessionOverflow.preflight({
              cfg: {},
              model,
              usable: model.limit.context - 1024,
              messages: base.messages,
              tools: schemas,
              output: base.params.maxOutputTokens,
            })
            const costs = Object.entries(schemas)
              .map(([id, value]) => ({
                id,
                tokens: KiloSessionOverflow.measure({ messages: [], tools: { [id]: value } }).normalized,
              }))
              .sort((a, b) => b.tokens - a.tokens)
            rows.push({
              agent: name,
              system,
              catalog,
              fixed: checked.fixed,
              input: checked.tokens,
              irreducible: checked.irreducible,
              output: base.params.maxOutputTokens,
              context: model.limit.context,
              tools: Object.keys(schemas).length,
              promptBytes: Buffer.byteLength(agent.prompt ?? ""),
              skillsBytes: Buffer.byteLength(skills ?? ""),
              instructionsBytes: Buffer.byteLength(instructions.join("\n")),
              costs: costs.slice(0, 10),
            })
            console.log(
              JSON.stringify({ format: "raya.voice-budget-agent", row: rows.at(-1), inferenceInvoked: false }),
            )
          }
          console.log(JSON.stringify({ format: "raya.voice-budget-baseline", rows, inferenceInvoked: false }))
          expect(rows[0].system).toBeGreaterThan(0)
          expect(rows[0].irreducible).toBe(false)
          expect(rows[0].output).toBe(1024)
          expect(rows[0].system + rows[0].catalog + (rows[0].output ?? 0)).toBeLessThan(32768)
        }),
      {
        config: {
          enabled_providers: ["qwen-local"],
          model: "qwen-local/qwen3-raya-32k:latest",
          small_model: "qwen-local/qwen3-raya-32k:latest",
          permission: { bash: "allow" },
          mcp: {},
          plugin: [],
          provider: {
            "qwen-local": {
              npm: "@ai-sdk/openai-compatible",
              name: "Isolated local budget fixture",
              env: [],
              options: { baseURL: "http://127.0.0.1:11434/v1", localInference: true, localInferenceAPI: "ollama" },
              models: {
                "qwen3-raya-32k:latest": {
                  name: "qwen3-raya-32k:latest",
                  tool_call: true,
                  options: { reasoningEffort: "none" },
                  limit: { context: 32768, output: 1024 },
                },
              },
            },
          },
        },
      },
    ),
  60000,
)

test("bounds only exact primary Voice without widening other roles", () => {
  expect(LazyTools.eligible({ name: "voice", mode: "primary" })).toBe(true)
  expect(LazyTools.eligible({ name: "voice", mode: "subagent" })).toBe(false)
  expect(LazyTools.eligible({ name: "voice", mode: "all" })).toBe(false)
  expect(LazyTools.eligible({ name: "voice" })).toBe(false)
  expect(LazyTools.eligible({ name: "local-voice", mode: "primary" })).toBe(false)
  expect(LazyTools.eligible({ name: "auto", mode: "primary" })).toBe(false)
})
