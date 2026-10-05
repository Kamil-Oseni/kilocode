import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { expect, setDefaultTimeout } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Skill } from "../../src/skill"
import { Token } from "../../src/util/token"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Skill.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
  ),
)
setDefaultTimeout(20_000)

it.instance("keeps the bundled design doctrine available to actual native agents", () =>
  Effect.gen(function* () {
    const svc = yield* Agent.Service
    const catalog = yield* Skill.Service
    const skill = yield* catalog.require("designer")
    expect(skill.content).toContain("Design from first principles, not vibes")
    const rows: Array<{ name: string; characters: number; estimated_tokens: number }> = []
    const prompts: Record<string, string> = {}
    for (const name of ["ask", "code", "plan", "debug", "generalist", "coder", "accountant", "reasoner", "designer"]) {
      const agent = yield* svc.get(name)
      expect(agent).toBeDefined()
      if (!agent) throw new Error("Native agent missing")
      expect(Permission.evaluate("skill", "designer", agent.permission).action).toBe("allow")
      expect((yield* catalog.available(agent)).some((item) => item.name === "designer")).toBe(true)
      const prompt = agent.prompt ?? ""
      prompts[name] = prompt
      if (name === "designer") {
        expect(prompt.split(skill.content.trim()).length - 1).toBe(1)
        expect(prompt).toContain("Canvas work wins over browser work")
      }
      if (name !== "designer") {
        expect(prompt).not.toContain("You are a senior product designer")
        expect(prompt).toContain("bundled designer skill")
      }
      rows.push({ name, characters: agent.prompt?.length ?? 0, estimated_tokens: Token.estimate(agent.prompt ?? "") })
    }
    const target = process.env.RAYA_PROMPT_AUDIT
    if (target) yield* Effect.promise(() => Bun.write(target, JSON.stringify(rows, null, 2)))
    const output = process.env.RAYA_PROMPT_EXPORT
    if (output) yield* Effect.promise(() => Bun.write(output, JSON.stringify(prompts, null, 2)))
  }),
)
