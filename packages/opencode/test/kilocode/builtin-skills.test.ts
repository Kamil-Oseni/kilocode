import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { expect, setDefaultTimeout } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"
import { Skill } from "../../src/skill"
import * as KiloSkill from "../../src/kilocode/skill-remove"
import { BUILTIN_SKILLS } from "../../src/kilocode/skills/builtin"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Skill.node), AppNodeBuilder.build(CrossSpawnSpawner.node)))
setDefaultTimeout(10_000)

it.instance(
  "built-in skills are present in empty project",
  () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const skills = yield* skill.all()
      for (const builtin of BUILTIN_SKILLS) {
        const found = skills.find((s) => s.name === builtin.name)
        expect(found).toBeDefined()
        expect(found!.location).toBe(Skill.BUILTIN_LOCATION)
        expect(found!.description).toBe(builtin.description)
        expect(found!.content.length).toBeGreaterThan(0)
        expect(found!.provenance.source.kind).toBe("builtin")
        expect(found!.provenance.source.trusted).toBe(true)
        expect(found!.provenance.sha256).toHaveLength(64)
      }
    }),
  { git: true },
)

it.instance(
  "built-in skill has correct metadata",
  () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const item = yield* skill.get("kilo-config")
      expect(item).toBeDefined()
      expect(item!.name).toBe("kilo-config")
      expect(item!.location).toBe(Skill.BUILTIN_LOCATION)
      expect(item!.content).toContain("kilo")
      expect(item!.provenance.resolution.result).toBe("selected")
    }),
  { git: true },
)

it.instance(
  "universal role skills retain stable versioned identities",
  () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      for (const name of ["coding", "designer", "writing", "marketing"] as const) {
        const item = yield* skill.get(name)
        expect(item?.location).toBe(Skill.BUILTIN_LOCATION)
        expect(item?.provenance.source.locator).toBe(`raya:bundled:${name}`)
        expect(item?.provenance.skillVersion).toBe("1")
        if (name !== "designer") expect(item?.content).toContain(`name: ${name}`)
      }
    }),
  { git: true },
)

it.instance(
  "kilo-config is protected from removal",
  () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const item = yield* skill.get("kilo-config")
      expect(item).toBeDefined()
      expect(KiloSkill.builtin(item!.location)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "user skill overrides built-in with same name",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = path.join(instance.directory, ".kilo", "skill", "kilo-config")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "SKILL.md"),
          `---
name: kilo-config
description: User override of kilo-config.
---

# Custom kilo-config

User-provided content.
`,
        ),
      )

      const skill = yield* Skill.Service
      const item = yield* skill.get("kilo-config")
      expect(item).toBeDefined()
      expect(item!.description).toBe("User override of kilo-config.")
      expect(item!.location).not.toBe(Skill.BUILTIN_LOCATION)
      expect(item!.location).toContain(path.join("skill", "kilo-config", "SKILL.md"))
      expect(item!.provenance.source.kind).toBe("project")
      expect(item!.provenance.source.trusted).toBe(false)
      expect(item!.provenance.resolution.shadowed[0]?.kind).toBe("builtin")
      expect(item!.provenance.resolution.shadowed[0]?.sha256).toHaveLength(64)
    }),
  { git: true },
)

it.instance(
  "same-scope duplicates resolve by normalized path with a receipt",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const root = path.join(instance.directory, ".kilo", "skills")
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(
            path.join(root, "z-last", "SKILL.md"),
            '---\nname: ordered\ndescription: Last path.\nmetadata:\n  version: "2"\n---\n\n# Last\n',
          ),
          Bun.write(
            path.join(root, "a-first", "SKILL.md"),
            '---\nname: ordered\ndescription: First path.\nmetadata:\n  version: "1"\n---\n\n# First\n',
          ),
        ]),
      )

      const skill = yield* Skill.Service
      const item = yield* skill.get("ordered")
      expect(item?.description).toBe("Last path.")
      expect(item?.provenance.skillVersion).toBe("2")
      expect(item?.provenance.source.kind).toBe("project")
      expect(item?.provenance.resolution.shadowed[0]?.version).toBe("1")
      expect(item?.provenance.resolution.shadowed[0]?.order).toBeLessThan(item?.provenance.resolution.order ?? 0)
    }),
  { git: true },
)
