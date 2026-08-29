// raya_change - verify Raya's bundled typography is applied, not merely declared
import { describe, expect, test } from "bun:test"
import path from "node:path"

const root = path.join(import.meta.dir, "../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

describe("Raya typography hierarchy", () => {
  test("maps the shared sans token to Outfit and gives response headings a display scale", async () => {
    const css = await read("webview-ui/src/styles/eden.css")

    expect(css).toContain('--font-body: "Outfit"')
    expect(css).toContain('--font-display: "Instrument Serif"')
    expect(css).toContain("--font-family-sans: var(--font-body)")
    expect(css).toContain('[data-component="markdown"] h1')
    expect(css).toContain("font-size: 1.5em")
    expect(css).toContain('[data-slot="task-header-title-label"]')
    expect(css).toContain('.vscode-session-turn[data-row="assistant"]')
    expect(css).toContain("padding-bottom: var(--raya-space-24)")
    expect(css).toContain(':where([data-component="text-part"], [data-slot="text-part-body"])')
    expect(css).toContain('[data-component="user-message"] [data-slot="user-message-text"]')
    expect(css).toContain('[data-component="tool-part-wrapper"]')
    expect(css).toContain("background: transparent")
  })

  test("loads the type foundation in every customer-facing webview", async () => {
    const entries = [
      "webview-ui/src/styles/chat.css",
      "webview-ui/marketplace/index.tsx",
      "webview-ui/kiloclaw/index.tsx",
    ]
    const sources = await Promise.all(entries.map(read))

    expect(sources.every((source) => source.includes("eden.css"))).toBe(true)
  })
})
