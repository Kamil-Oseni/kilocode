import { describe, expect, it } from "bun:test"

const source = await Bun.file(new URL("../../src/services/computer-use/desktop-panel.ts", import.meta.url)).text()

describe("Computer Use preview shell", () => {
  it("keeps captured identity private and uses a strict webview policy", () => {
    expect(source).toContain("default-src 'none'; img-src data:")
    expect(source).not.toContain("unsafe-inline")
    expect(source).not.toContain("location: frame.location")
    expect(source).toContain("Latest foreground window observation")
  })

  it("exposes explicit takeover and responsive controls", () => {
    expect(source).toContain("Pause agent control")
    expect(source).toContain("Resume agent control")
    expect(source).toContain('"takeover" | "resume"')
    expect(source).toContain('send(manual ? "resume" : "takeover")')
    expect(source).toContain("@media (max-width: 520px)")
  })
})
