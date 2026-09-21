// kilocode_change - new file
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { expect, setDefaultTimeout } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Skill } from "../../src/skill"

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Skill.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
  ),
)
setDefaultTimeout(20_000)

function action(name: string, ruleset: Permission.Ruleset) {
  return Permission.evaluate("skill", name, ruleset).action
}

it.instance("all user-facing native agents can load universal skills while system agents cannot", () =>
  Effect.gen(function* () {
    const svc = yield* Agent.Service
    const catalog = yield* Skill.Service
    const agents = yield* svc.list()
    const deny = new Set(["compaction", "title", "summary"])
    const users = agents.filter((agent) => agent.native && !deny.has(agent.name))
    const names = users.map((agent) => agent.name)
    for (const name of ["auto", "code", "voice", "plan", "debug", "ask", "generalist", "coder", "designer"]) {
      expect(names).toContain(name)
    }
    for (const agent of users) {
      const available = (yield* catalog.available(agent)).map((item) => item.name)
      for (const name of ["coding", "designer", "writing", "marketing"]) {
        expect(action(name, agent.permission)).toBe("allow")
        expect(available).toContain(name)
      }
      expect(Permission.disabled(["skill"], agent.permission).has("skill")).toBe(false)
    }

    for (const name of deny) {
      const agent = yield* svc.get(name)
      expect(agent).toBeDefined()
      expect(action("coding", agent.permission)).toBe("deny")
      expect(Permission.disabled(["skill"], agent.permission).has("skill")).toBe(true)
    }
  }),
)
