// kilocode_change start - Tests for Raya/Kilo config content merging
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { buildConfigEnv, createKiloServer } from "../src/server"
import { buildConfigEnv as buildV2ConfigEnv, createKiloServer as createV2KiloServer } from "../src/v2/server"

describe("buildConfigEnv", () => {
  const kilo = process.env.KILO_CONFIG_CONTENT
  const raya = process.env.RAYA_CONFIG_CONTENT

  beforeEach(() => {
    delete process.env.KILO_CONFIG_CONTENT
    delete process.env.RAYA_CONFIG_CONTENT
  })

  afterEach(() => {
    if (kilo === undefined) {
      delete process.env.KILO_CONFIG_CONTENT
    } else {
      process.env.KILO_CONFIG_CONTENT = kilo
    }
    if (raya === undefined) {
      delete process.env.RAYA_CONFIG_CONTENT
    } else {
      process.env.RAYA_CONFIG_CONTENT = raya
    }
  })

  test("reads Raya-only config content in both SDK generations", () => {
    process.env.RAYA_CONFIG_CONTENT = JSON.stringify({ model: "raya-model" })

    for (const build of [buildConfigEnv, buildV2ConfigEnv]) {
      expect(JSON.parse(build()).model).toBe("raya-model")
    }
  })

  test("keeps Kilo-only config content compatible in both SDK generations", () => {
    process.env.KILO_CONFIG_CONTENT = JSON.stringify({ model: "kilo-model" })

    for (const build of [buildConfigEnv, buildV2ConfigEnv]) {
      expect(JSON.parse(build()).model).toBe("kilo-model")
    }
  })

  test("prefers defined Raya config content when aliases conflict", () => {
    process.env.RAYA_CONFIG_CONTENT = JSON.stringify({ model: "raya-model" })
    process.env.KILO_CONFIG_CONTENT = JSON.stringify({ model: "kilo-model" })

    for (const build of [buildConfigEnv, buildV2ConfigEnv]) {
      expect(JSON.parse(build()).model).toBe("raya-model")
    }
  })

  test("treats an explicitly empty Raya value as authoritative", () => {
    process.env.RAYA_CONFIG_CONTENT = ""
    process.env.KILO_CONFIG_CONTENT = JSON.stringify({ model: "kilo-model" })

    for (const build of [buildConfigEnv, buildV2ConfigEnv]) {
      expect(JSON.parse(build()).model).toBeUndefined()
    }
  })

  test("returns empty config when no existing env and no incoming config", () => {
    const result = buildConfigEnv()
    const parsed = JSON.parse(result)

    expect(parsed).toEqual({
      agent: {},
      command: {},
      mcp: {},
      mode: {},
      plugin: [],
      instructions: [],
    })
  })

  test("returns incoming config when no existing env", () => {
    const result = buildConfigEnv({
      agent: { custom: { mode: "primary", prompt: "test" } },
    })
    const parsed = JSON.parse(result)

    expect(parsed.agent).toEqual({ custom: { mode: "primary", prompt: "test" } })
  })

  test("preserves existing KILO_CONFIG_CONTENT when spawning with new config", () => {
    // Simulate Kilocode having injected modes via KILO_CONFIG_CONTENT
    process.env.KILO_CONFIG_CONTENT = JSON.stringify({
      agent: {
        translate: { mode: "primary", prompt: "You are a translator" },
      },
      instructions: [".kilo/rules/main.md"],
    })

    // Now spawn with additional config
    const result = buildConfigEnv({
      agent: { review: { mode: "primary", prompt: "You are a reviewer" } },
      instructions: ["additional-rule.md"],
    })
    const parsed = JSON.parse(result)

    // Both agents should be present
    expect(parsed.agent.translate).toEqual({ mode: "primary", prompt: "You are a translator" })
    expect(parsed.agent.review).toEqual({ mode: "primary", prompt: "You are a reviewer" })

    // Both instructions should be present
    expect(parsed.instructions).toContain(".kilo/rules/main.md")
    expect(parsed.instructions).toContain("additional-rule.md")
  })

  test("incoming config overrides existing config for same keys", () => {
    process.env.KILO_CONFIG_CONTENT = JSON.stringify({
      agent: { code: { mode: "primary", prompt: "Original prompt" } },
      model: "original-model",
    })

    const result = buildConfigEnv({
      agent: { code: { mode: "primary", prompt: "New prompt" } },
      model: "new-model",
    })
    const parsed = JSON.parse(result)

    // Agent should be overridden
    expect(parsed.agent.code.prompt).toBe("New prompt")
    // Top-level config should be overridden
    expect(parsed.model).toBe("new-model")
  })

  test("handles invalid JSON in existing KILO_CONFIG_CONTENT gracefully", () => {
    process.env.KILO_CONFIG_CONTENT = "invalid json {"

    const result = buildConfigEnv({
      agent: { test: { mode: "primary", prompt: "test" } },
    })
    const parsed = JSON.parse(result)

    // Should still work with just the incoming config
    expect(parsed.agent.test).toEqual({ mode: "primary", prompt: "test" })
  })

  test("merges plugins from both sources", () => {
    process.env.KILO_CONFIG_CONTENT = JSON.stringify({
      plugin: ["plugin-a", "plugin-b"],
    })

    const result = buildConfigEnv({
      plugin: ["plugin-c"],
    })
    const parsed = JSON.parse(result)

    expect(parsed.plugin).toEqual(["plugin-a", "plugin-b", "plugin-c"])
  })

  test("synchronizes computed content into both child aliases in both SDK generations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raya-sdk-"))
    const capture = join(dir, "env.json")
    const script = join(dir, "kilo.js")
    const path = process.env.PATH
    process.env.RAYA_CONFIG_CONTENT = JSON.stringify({ model: "base-model" })
    process.env.KILO_CONFIG_CONTENT = JSON.stringify({ model: "ignored-model" })
    process.env.RAYA_SDK_CAPTURE = capture
    process.env.PATH = `${dir}${delimiter}${path ?? ""}`
    writeFileSync(
      script,
      [
        `await Bun.write(process.env.RAYA_SDK_CAPTURE, JSON.stringify({ raya: process.env.RAYA_CONFIG_CONTENT, kilo: process.env.KILO_CONFIG_CONTENT }))`,
        `console.log("kilo server listening on http://127.0.0.1:4096")`,
      ].join("\n"),
    )
    writeFileSync(join(dir, "kilo.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0kilo.js"\r\n`)
    const bin = join(dir, "kilo")
    writeFileSync(bin, `#!${process.execPath}\nawait import("./kilo.js")\n`)
    chmodSync(bin, 0o755)

    for (const create of [createKiloServer, createV2KiloServer]) {
      const server = await create({ config: { model: "nested-model" } })
      server.close()
      const child = await Bun.file(capture).json()

      expect(child.raya).toBe(child.kilo)
      expect(JSON.parse(child.raya).model).toBe("nested-model")
    }

    delete process.env.RAYA_SDK_CAPTURE
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  })
})
// kilocode_change end
