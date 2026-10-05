import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SystemPrompt } from "@/session/system"
import { LLMRequestPrep } from "@/session/llm/request"
import { SessionID, MessageID } from "@/session/schema"
import { ConfigPublication } from "@/kilocode/config/publication"
import { provideInstance, tmpdir, testInstanceStoreLayer } from "../fixture/fixture"

const layer = LayerNode.compile(LayerNode.group([Agent.node, Provider.node, Plugin.node, RuntimeFlags.node]))
const local = {
  enabled_providers: ["local"],
  model: "local/fixture",
  small_model: "local/fixture",
  plugin: [],
  mcp: {},
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Model-free Code guidance fixture",
      env: [],
      options: { baseURL: "http://127.0.0.1:1/v1", localInference: true },
      models: { fixture: { name: "fixture", tool_call: true, limit: { context: 32768, output: 1024 } } },
    },
  },
}

for (const name of ["default", "code", "build"]) {
  test(`prepares genuine ${name} Code without inference`, async () => {
    const custom = name !== "default"
    await using dir = await tmpdir({
      config: { ...local, agent: custom ? { [name]: { prompt: "CUSTOM_CODE_AUTHORITY" } } : {} },
    })
    await ConfigPublication.using(path.join(dir.path, "metadata"), () =>
      Effect.runPromise(
        provideInstance(dir.path)(
          Effect.gen(function* () {
            const agents = yield* Agent.Service
            const provider = yield* Provider.Service
            const plugin = yield* Plugin.Service
            const flags = yield* RuntimeFlags.Service
            const model = yield* provider.getModel(ProviderV2.ID.make("local"), ModelV2.ID.make("fixture"))
            const info = yield* provider.getProvider(model.providerID)
            const agent = yield* agents.get("code")
            const user = {
              id: MessageID.ascending(),
              sessionID: SessionID.make("ses_guidance"),
              role: "user" as const,
              time: { created: Date.now() },
              agent: "code",
              model: { providerID: model.providerID, modelID: model.id },
            }
            const prepare = (selected: typeof agent) =>
              LLMRequestPrep.prepare({
                user,
                sessionID: user.sessionID,
                agent: selected,
                model,
                system: [],
                messages: [{ role: "user", content: "Preserve my exact command, workdir and final reply." }],
                tools: {},
                provider: info,
                auth: undefined,
                plugin,
                flags,
                isWorkflow: false,
              })
            const prepared = yield* prepare(agent)
            const text = prepared.system.join("\n")
            const baseline = SystemPrompt.provider(model)[0]
            if (custom) {
              expect(agent.prompt).toBe("CUSTOM_CODE_AUTHORITY")
              expect(text).toContain("CUSTOM_CODE_AUTHORITY")
              expect(text).not.toContain(baseline)
              expect(text).not.toContain("Preserve explicit execution constraints")
              return
            }
            expect(text).toContain(baseline)
            expect(text).toContain(agent.prompt!)
            expect(text).toContain("Preserve explicit execution constraints")
            expect(text).toContain("workdir parameter")
            expect(text).toContain("exact final response")
            expect(text).toContain("Treat ordinary requests to create or change a recurring worker")
            expect(text).toContain("Delegate substantial specialist")
            const override = yield* prepare({ ...agent, prompt: "CLONED_CODE_AUTHORITY" })
            expect(override.system.join("\n")).toContain("CLONED_CODE_AUTHORITY")
            expect(override.system.join("\n")).not.toContain(baseline)
            expect(override.system.join("\n")).not.toContain("Preserve explicit execution constraints")
            for (const name of ["ask", "plan", "auto"]) {
              const other = yield* agents.get(name)
              const kept = yield* prepare(other)
              expect(kept.system.join("\n")).toContain(other.prompt!)
              expect(kept.system.join("\n")).not.toContain("Preserve explicit execution constraints")
            }
          }),
        ).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(layer), Effect.scoped),
      ),
    )
  }, 60000)
}
