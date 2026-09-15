import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

it.effect("agent permissions resolve managed output from the active profile", () => {
  const original = Global.Path.data
  const active = path.join(original, "late-bound-agent-test")

  return Effect.gen(function* () {
    Global.Path.data = active
    const agent = yield* AgentV2.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
      Effect.provideService(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
      ),
    )

    const build = yield* agent.get(AgentV2.ID.make("build"))
    const expected = path.join(active, "tool-output", "*")
    expect(build?.permissions).toContainEqual({ action: "external_directory", resource: expected, effect: "allow" })
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        Global.Path.data = original
      }),
    ),
  )
})
