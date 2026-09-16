import { afterEach, describe, expect } from "bun:test" // kilocode_change
import { ConfigProvider, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EnvAlias } from "@opencode-ai/core/kilocode/env-alias" // kilocode_change
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { it } from "../lib/effect"

const fromConfig = (input: Record<string, unknown>) =>
  AppNodeBuilder.build(RuntimeFlags.node).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))

const readFlags = RuntimeFlags.Service.useSync((flags) => flags)

afterEach(() => EnvAlias.conflicts()) // kilocode_change

describe("RuntimeFlags", () => {
  it.effect("layer defaults autoShare to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.autoShare).toBe(false)
      expect(flags.experimentalBackgroundSubagents).toBe(true) // kilocode_change
    }),
  )

  // kilocode_change start - preserve the background-subagent kill switch
  it.effect("allows disabling background subagents explicitly", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(fromConfig({ KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false" })),
      )

      expect(flags.experimentalBackgroundSubagents).toBe(false)
    }),
  )
  // kilocode_change end

  it.effect("layer parses plugin flags from the active ConfigProvider", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            KILO_PURE: "true",
            KILO_DISABLE_DEFAULT_PLUGINS: "true",
            KILO_AUTO_SHARE: "true",
            KILO_DISABLE_EMBEDDED_WEB_UI: "true",
            KILO_DISABLE_EXTERNAL_SKILLS: "true",
            KILO_DISABLE_LSP_DOWNLOAD: "true",
            KILO_EXPERIMENTAL: "true",
            KILO_ENABLE_EXA: "true",
            KILO_ENABLE_PARALLEL: "true",
            KILO_ENABLE_EXPERIMENTAL_MODELS: "true",
            KILO_ENABLE_QUESTION_TOOL: "true",
            KILO_CLIENT: "desktop",
          }),
        ),
      )

      expect(flags.pure).toBe(true)
      expect(flags.autoShare).toBe(true)
      expect(flags.disableDefaultPlugins).toBe(true)
      expect(flags.disableEmbeddedWebUi).toBe(true)
      expect(flags.disableExternalSkills).toBe(true)
      expect(flags.disableLspDownload).toBe(true)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.enableExa).toBe(true)
      expect(flags.enableParallel).toBe(true)
      expect(flags.enableExperimentalModels).toBe(true)
      expect(flags.enableQuestionTool).toBe(true)
      expect(flags.experimentalReferences).toBe(true)
      expect(flags.experimentalLspTy).toBe(false)
      expect(flags.experimentalLspTool).toBe(true)
      expect(flags.experimentalOxfmt).toBe(true)
      expect(flags.experimentalPlanMode).toBe(true)
      expect(flags.experimentalEventSystem).toBe(true)
      expect(flags.experimentalWorkspaces).toBe(true)
      expect(flags.experimentalIconDiscovery).toBe(true)
      expect(flags.experimentalNativeLlm).toBe(false)
      expect(flags.experimentalWebSockets).toBe(false)
      expect(flags.client).toBe("desktop")
    }),
  )

  // kilocode_change start - Raya/Kilo pure-mode aliases are safety-monotonic
  for (const input of [
    { name: "Raya only", config: { RAYA_PURE: "true" } },
    { name: "Kilo fallback", config: { KILO_PURE: "true" } },
    { name: "Raya true and Kilo false", config: { RAYA_PURE: "true", KILO_PURE: "false" } },
    { name: "Raya false and Kilo true", config: { RAYA_PURE: "false", KILO_PURE: "true" } },
    { name: "empty Raya and Kilo true", config: { RAYA_PURE: "", KILO_PURE: "true" } },
  ]) {
    it.effect(`enables pure mode from ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))
        expect(flags.pure).toBe(true)
      }),
    )
  }

  it.effect("keeps pure mode disabled when both aliases are false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ RAYA_PURE: "false", KILO_PURE: "false" })))
      expect(flags.pure).toBe(false)
    }),
  )

  it.effect("records only pure alias labels when server config aliases conflict", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ RAYA_PURE: "false", KILO_PURE: "true" })))
      expect(flags.pure).toBe(true)
      expect(EnvAlias.conflicts()).toEqual(["RAYA_PURE/KILO_PURE"])
    }),
  )
  // kilocode_change end

  // kilocode_change start - disable aliases are safety-monotonic
  for (const pair of [
    {
      fields: ["disableDefaultPlugins"] as const,
      raya: "RAYA_DISABLE_DEFAULT_PLUGINS",
      kilo: "KILO_DISABLE_DEFAULT_PLUGINS",
    },
    {
      fields: ["disableLspDownload"] as const,
      raya: "RAYA_DISABLE_LSP_DOWNLOAD",
      kilo: "KILO_DISABLE_LSP_DOWNLOAD",
    },
    {
      fields: ["disableEmbeddedWebUi"] as const,
      raya: "RAYA_DISABLE_EMBEDDED_WEB_UI",
      kilo: "KILO_DISABLE_EMBEDDED_WEB_UI",
    },
    {
      fields: ["disableExternalSkills"] as const,
      raya: "RAYA_DISABLE_EXTERNAL_SKILLS",
      kilo: "KILO_DISABLE_EXTERNAL_SKILLS",
    },
    {
      fields: ["disableSkillShell"] as const,
      raya: "RAYA_DISABLE_SKILL_SHELL",
      kilo: "KILO_DISABLE_SKILL_SHELL",
    },
    {
      fields: ["disableClaudeCodePrompt", "disableClaudeCodeSkills"] as const,
      raya: "RAYA_DISABLE_CLAUDE_CODE",
      kilo: "KILO_DISABLE_CLAUDE_CODE",
    },
    {
      fields: ["disableClaudeCodePrompt"] as const,
      raya: "RAYA_DISABLE_CLAUDE_CODE_PROMPT",
      kilo: "KILO_DISABLE_CLAUDE_CODE_PROMPT",
    },
    {
      fields: ["disableClaudeCodeSkills"] as const,
      raya: "RAYA_DISABLE_CLAUDE_CODE_SKILLS",
      kilo: "KILO_DISABLE_CLAUDE_CODE_SKILLS",
    },
  ]) {
    for (const input of [
      { name: "neither alias", raya: undefined, kilo: undefined, expected: false, conflict: false },
      { name: "Raya only", raya: "true", kilo: undefined, expected: true, conflict: false },
      { name: "Kilo only", raya: undefined, kilo: "1", expected: true, conflict: false },
      { name: "both aliases", raya: "true", kilo: "true", expected: true, conflict: false },
      { name: "Raya false and Kilo true", raya: "false", kilo: "true", expected: true, conflict: true },
      { name: "Raya true and Kilo false", raya: "true", kilo: "false", expected: true, conflict: true },
      { name: "empty Raya and Kilo true", raya: "", kilo: "true", expected: true, conflict: true },
      { name: "invalid Raya and Kilo true", raya: "invalid", kilo: "true", expected: true, conflict: true },
    ]) {
      it.effect(`${pair.fields.join("+")} handles ${input.name}`, () =>
        Effect.gen(function* () {
          const config = {
            ...(input.raya === undefined ? {} : { [pair.raya]: input.raya }),
            ...(input.kilo === undefined ? {} : { [pair.kilo]: input.kilo }),
          }
          const flags = yield* readFlags.pipe(Effect.provide(fromConfig(config)))

          for (const field of pair.fields) expect(flags[field]).toBe(input.expected)
          expect(EnvAlias.conflicts()).toEqual(input.conflict ? [`${pair.raya}/${pair.kilo}`] : [])
        }),
      )
    }
  }

  it.effect("keeps the direct Claude prompt and skill switches separate", () =>
    Effect.gen(function* () {
      const prompt = yield* readFlags.pipe(Effect.provide(fromConfig({ RAYA_DISABLE_CLAUDE_CODE_PROMPT: "true" })))
      const skills = yield* readFlags.pipe(Effect.provide(fromConfig({ RAYA_DISABLE_CLAUDE_CODE_SKILLS: "true" })))

      expect(prompt.disableClaudeCodePrompt).toBe(true)
      expect(prompt.disableClaudeCodeSkills).toBe(false)
      expect(skills.disableClaudeCodePrompt).toBe(false)
      expect(skills.disableClaudeCodeSkills).toBe(true)
    }),
  )
  // kilocode_change end

  it.effect("layer parses KILO_EXPERIMENTAL_LSP_TY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            KILO_EXPERIMENTAL_LSP_TY: "true",
          }),
        ),
      )

      expect(flags.experimentalLspTy).toBe(true)
    }),
  )

  it.effect("enables native LLM via dedicated flag only", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(Effect.provide(fromConfig({ KILO_EXPERIMENTAL_NATIVE_LLM: "true" })))
      const umbrella = yield* readFlags.pipe(Effect.provide(fromConfig({ KILO_EXPERIMENTAL: "true" })))

      expect(explicit.experimentalNativeLlm).toBe(true)
      expect(umbrella.experimentalNativeLlm).toBe(false)
    }),
  )

  it.effect("enables WebSockets via dedicated flag only", () =>
    Effect.gen(function* () {
      const explicit = yield* readFlags.pipe(Effect.provide(fromConfig({ KILO_EXPERIMENTAL_WEBSOCKETS: "true" })))
      const umbrella = yield* readFlags.pipe(Effect.provide(fromConfig({ KILO_EXPERIMENTAL: "true" })))

      expect(explicit.experimentalWebSockets).toBe(true)
      expect(umbrella.experimentalWebSockets).toBe(false)
    }),
  )

  it.effect("layer accepts partial test overrides and fills defaults from Config definitions", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(RuntimeFlags.layer({ disableDefaultPlugins: true, bashDefaultTimeoutMs: 1_000 })),
      )

      expect(flags.pure).toBe(false)
      expect(flags.autoShare).toBe(false)
      expect(flags.disableDefaultPlugins).toBe(true)
      expect(flags.disableEmbeddedWebUi).toBe(false)
      expect(flags.disableExternalSkills).toBe(false)
      expect(flags.disableLspDownload).toBe(false)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.disableClaudeCodeSkills).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBe(1_000)
      expect(flags.enableExperimentalModels).toBe(false)
      expect(flags.client).toBe("cli")
    }),
  )

  it.effect("experimentalIconDiscovery defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalIconDiscovery).toBe(false)
    }),
  )

  it.effect("experimentalIconDiscovery reads KILO_EXPERIMENTAL_ICON_DISCOVERY", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ KILO_EXPERIMENTAL_ICON_DISCOVERY: "true" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("experimentalIconDiscovery inherits KILO_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({ KILO_EXPERIMENTAL: "true" })))

      expect(flags.experimentalIconDiscovery).toBe(true)
    }),
  )

  it.effect("specific experimental flags override KILO_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            KILO_EXPERIMENTAL: "true",
            KILO_EXPERIMENTAL_ICON_DISCOVERY: "false",
          }),
        ),
      )

      expect(flags.experimentalIconDiscovery).toBe(false)
    }),
  )

  it.effect("experimentalOxfmt defaults to false", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(fromConfig({})))

      expect(flags.experimentalOxfmt).toBe(false)
    }),
  )

  it.effect("experimentalOxfmt is enabled by KILO_EXPERIMENTAL_OXFMT", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            KILO_EXPERIMENTAL_OXFMT: "true",
          }),
        ),
      )

      expect(flags.experimentalOxfmt).toBe(true)
    }),
  )

  it.effect("experimentalOxfmt inherits KILO_EXPERIMENTAL", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(
          fromConfig({
            KILO_EXPERIMENTAL: "true",
          }),
        ),
      )

      expect(flags.experimentalOxfmt).toBe(true)
    }),
  )

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "0" }, expected: undefined },
    { name: "negative", config: { KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses bashDefaultTimeoutMs from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.bashDefaultTimeoutMs).toBe(input.expected)
      }),
    )
  }

  for (const input of [
    { name: "absent", config: {}, expected: undefined },
    {
      name: "valid positive integer",
      config: { KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1234" },
      expected: 1234,
    },
    {
      name: "invalid string",
      config: { KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "nope" },
      expected: undefined,
    },
    { name: "zero", config: { KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "0" }, expected: undefined },
    { name: "negative", config: { KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "-1" }, expected: undefined },
    {
      name: "non-integer",
      config: { KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1.5" },
      expected: undefined,
    },
  ]) {
    it.effect(`parses outputTokenMax from config: ${input.name}`, () =>
      Effect.gen(function* () {
        const flags = yield* readFlags.pipe(Effect.provide(fromConfig(input.config)))

        expect(flags.outputTokenMax).toBe(input.expected)
      }),
    )
  }

  it.effect("layer ignores the active ConfigProvider for omitted test overrides", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(
        Effect.provide(RuntimeFlags.layer()),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              KILO_PURE: "true",
              KILO_DISABLE_DEFAULT_PLUGINS: "true",
              KILO_DISABLE_EXTERNAL_SKILLS: "true",
              KILO_DISABLE_LSP_DOWNLOAD: "true",
              KILO_EXPERIMENTAL: "true",
              KILO_ENABLE_EXA: "true",
              KILO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "1234",
              KILO_CLIENT: "desktop",
            }),
          ),
        ),
      )

      expect(flags.pure).toBe(false)
      expect(flags.disableDefaultPlugins).toBe(false)
      expect(flags.disableEmbeddedWebUi).toBe(false)
      expect(flags.disableExternalSkills).toBe(false)
      expect(flags.disableLspDownload).toBe(false)
      expect(flags.disableClaudeCodePrompt).toBe(false)
      expect(flags.disableClaudeCodeSkills).toBe(false)
      expect(flags.enableExa).toBe(false)
      expect(flags.experimentalIconDiscovery).toBe(false)
      expect(flags.experimentalOxfmt).toBe(false)
      expect(flags.outputTokenMax).toBeUndefined()
      expect(flags.bashDefaultTimeoutMs).toBeUndefined()
      expect(flags.client).toBe("cli")
    }),
  )
})
