import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { testEffect } from "../lib/effect"
import { Config } from "../../src/config/config" // kilocode_change
import { resolve } from "@/kilocode/skills/resolution" // kilocode_change

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

// kilocode_change start - Skill services retain provenance for the selected source
const resolved: Skill.ResolvedInfo[] = skills.map((skill, order) => ({
  ...skill,
  provenance: resolve({
    source: { kind: "path", locator: skill.location, trusted: true },
    content: skill.content,
    order,
  }),
}))
// kilocode_change end

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  AppNodeBuilder.build(SystemPrompt.node, [
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          // kilocode_change start - fixture service returns selected-source receipts
          get: (name) => Effect.succeed(resolved.find((skill) => skill.name === name)),
          require: (name) => {
            const info = resolved.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: resolved.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(resolved),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(resolved),
          // kilocode_change end
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    expect(SystemPrompt.provider({ api: { id: "meta/muse-spark-preview" } } as Provider.Model)[0]).toContain(
      "Meta Muse Spark",
    )
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )
})
