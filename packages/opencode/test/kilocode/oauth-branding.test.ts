import { describe, expect, test } from "bun:test"
import path from "path"
import { KiloOauthCallbackPage } from "@opencode-ai/core/kilocode/oauth/page"

const root = path.join(__dirname, "..", "..")

describe("Raya OAuth branding", () => {
  test("Codex OAuth browser flow keeps protocol identity and uses Raya display copy", async () => {
    const src = await Bun.file(path.join(root, "src", "plugin", "openai", "codex.ts")).text()

    expect(src).toContain('originator: "kilo"')
    expect(src).toContain('"User-Agent": `kilo/${InstallationVersion}`')
    expect(src).toContain("KiloOauthCallbackPage")
    expect(src).not.toContain('originator: "opencode"')
    expect(src).not.toContain("return to OpenCode")
  })

  test("core OAuth browser flow uses Raya branding", async () => {
    const src = await Bun.file(path.join(root, "..", "core", "src", "plugin", "provider", "openai.ts")).text()
    const pages = [
      KiloOauthCallbackPage.success({ provider: "ChatGPT" }),
      KiloOauthCallbackPage.error("Denied", { provider: "ChatGPT" }),
    ]

    expect(src).toContain('originator: "kilo"')
    expect(src).toContain('"User-Agent": `kilo/${InstallationVersion}`')
    expect(src).toContain("KiloOauthCallbackPage")
    expect(src).not.toContain('originator: "opencode"')
    for (const page of pages) {
      expect(page).toContain("· Raya</title>")
      expect(page).toContain('aria-label="Raya"')
      expect(page).toContain('viewBox="0 0 100 100"')
      expect(page).not.toContain("OpenCode")
      expect(page).not.toContain("Kilo Code")
      expect(page).not.toContain('viewBox="0 0 234 42"')
    }
  })

  test("MCP OAuth callback page uses Raya branding", async () => {
    const src = await Bun.file(path.join(root, "src", "mcp", "oauth-callback.ts")).text()

    expect(src).toContain("<title>Raya - Authorization Successful</title>")
    expect(src).toContain("<title>Raya - Authorization Failed</title>")
    expect(src).toContain("return to Raya")
    expect(src).not.toContain("<title>Kilo - Authorization")
    expect(src).not.toContain("return to Kilo")
    expect(src).not.toContain("return to OpenCode")
    expect(src).toContain('font-family: "Outfit"')
    expect(src).toContain('font-family: "Instrument Serif"')
    expect(src).toContain('role="status"')
    expect(src).toContain('role="alert"')
    expect(src).toContain("prefers-color-scheme: dark")
    expect(src).not.toContain("#1a1a2e")
  })
})
