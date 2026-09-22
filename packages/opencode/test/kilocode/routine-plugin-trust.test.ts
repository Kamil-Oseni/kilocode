import { afterEach, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RayaTask } from "@/kilocode/task"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const trusted = {
  tool: {
    trusted_tool: {
      description: "trusted global tool",
      args: {},
      execute: async () => "trusted",
    },
    adjacent_tool: {
      description: "trusted but unassigned tool",
      args: {},
      execute: async () => "adjacent",
    },
  },
}

const local = {
  tool: {
    local_tool: {
      description: "project-local tool",
      args: {},
      execute: async () => "local",
    },
  },
}

const plugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () => Effect.succeed([trusted, local]),
    sources: () =>
      Effect.succeed([
        { hook: trusted, trusted: true, source: "global" },
        { hook: local, trusted: false, source: "project" },
      ]),
  }),
)

const layer = LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
  [
    Config.node,
    TestConfig.layer({
      directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".raya")])),
    }),
  ],
  [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  [Plugin.node, plugin],
])

const it = testEffect(layer)

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("admits only trusted plugin tools to Routine sessions", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const agent = yield* agents.get("build")
    if (!agent) throw new Error("build agent not found")
    const input = {
      providerID: ProviderV2.ID.openai,
      modelID: ModelV2.ID.make("test"),
      agent,
    }

    const chat = yield* registry.tools(input)
    expect(chat.map((tool) => tool.id)).toContain("trusted_tool")
    expect(chat.map((tool) => tool.id)).toContain("local_tool")

    const routine = yield* registry.tools({
      ...input,
      agent: {
        ...agent,
        permission: RayaTask.rules({ role: "generalist", access: "full", tools: ["trusted_tool", "read"] }),
      },
      trustedOnly: true,
    })
    expect(routine.map((tool) => tool.id)).toContain("trusted_tool")
    expect(routine.map((tool) => tool.id)).not.toContain("adjacent_tool")
    expect(routine.map((tool) => tool.id)).not.toContain("local_tool")
    expect(routine.map((tool) => tool.id)).toContain("read")
    expect(routine.map((tool) => tool.id)).not.toContain("write")

    const selected = routine.find((tool) => tool.id === "trusted_tool")
    if (!selected) throw new Error("selected trusted tool is missing")
    const result = yield* selected.execute(
      {},
      {
        sessionID: SessionID.make("ses_routine_plugin_trust"),
        messageID: MessageID.make("msg_routine_plugin_trust"),
        agent: agent.name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.die(new Error("trusted plugin dispatch must not require a fallback prompt")),
      },
    )
    expect(result.output).toBe("trusted")
  }),
)
