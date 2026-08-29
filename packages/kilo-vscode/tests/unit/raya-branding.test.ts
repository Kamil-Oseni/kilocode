// raya_change - keep inherited product copy out of Raya's customer-facing boundaries
import { describe, expect, test } from "bun:test"
import path from "node:path"

const root = path.join(import.meta.dir, "../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

describe("Raya branding boundary", () => {
  test("uses Raya marketplace metadata and setting descriptions", async () => {
    const pkg = JSON.parse(await read("package.json")) as {
      name: string
      displayName: string
      description: string
      contributes?: { configuration?: unknown }
    }
    const visible = JSON.stringify({
      displayName: pkg.displayName,
      description: pkg.description,
      configuration: pkg.contributes?.configuration,
    })

    expect(pkg.name).toBe("raya")
    expect(pkg.displayName).toBe("Raya")
    expect(visible).not.toMatch(/\bKilo\b/)
  })

  test("identifies every model-facing system prompt as Raya", async () => {
    const dir = path.join(root, "../opencode/src")
    const files = [
      "session/prompt/default.txt",
      "session/prompt/anthropic.txt",
      "session/prompt/beast.txt",
      "session/prompt/codex.txt",
      "session/prompt/gemini.txt",
      "session/prompt/gpt.txt",
      "session/prompt/kilocode-gpt-5.5.txt",
      "session/prompt/kimi.txt",
      "session/prompt/ling.txt",
      "session/prompt/meta.txt",
      "kilocode/soul.txt",
      "kilocode/session/native-plan-prompt.txt",
      "kilocode/review/review.txt",
    ]
    const prompts = await Promise.all(files.map((file) => Bun.file(path.join(dir, file)).text()))

    expect(prompts.every((prompt) => prompt.includes("You are Raya"))).toBe(true)
    expect(prompts.some((prompt) => /You are Kilo(?: Code)?/.test(prompt))).toBe(false)
  })

  test("reads current settings and sanitizes inherited translations in every locale", async () => {
    const files = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root, absolute: true })]
    const sources = await Promise.all(files.map((file) => Bun.file(file).text()))
    const language = await read("webview-ui/src/context/language.tsx")

    expect(sources.some((source) => /getConfiguration\((?:["'`])kilo-code\.new/.test(source))).toBe(false)
    expect(language).toContain('replace(/\\bKilo Code\\b|\\bKilo\\b/g, "Raya")')
  })

  test("ships Raya-only marketplace documentation", async () => {
    expect(await read("README.md")).toMatch(/^<!-- raya_change[\s\S]*\n# Raya/m)
    expect(await read("CHANGELOG.md")).toContain("# Raya changelog")
  })

  test("uses Raya identity throughout Changes editor chrome", async () => {
    const sources = await Promise.all([
      read("src/DiffVirtualProvider.ts"),
      read("src/diff/DiffViewerProvider.ts"),
      read("webview-ui/diff-viewer/DiffEndMarker.tsx"),
      read("webview-ui/agent-manager/agent-manager.css"),
    ])
    const visible = sources.join("\n")

    expect(visible).not.toContain("kilo-light.svg")
    expect(visible).not.toContain("kilo-dark.svg")
    expect(visible).not.toContain("kiloman")
    expect(visible).toContain("eden-logo-light.svg")
  })
})
