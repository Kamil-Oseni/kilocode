import { describe, expect, it } from "bun:test"

const source = await Bun.file(new URL("../../src/services/computer-use/desktop-panel.ts", import.meta.url)).text()

describe("Computer Use preview shell", () => {
  it("keeps captured identity private and uses a strict webview policy", () => {
    expect(source).toContain("default-src 'none'; img-src data:")
    expect(source).not.toContain("unsafe-inline")
    expect(source).not.toContain("location: frame.location")
    expect(source).toContain("Latest foreground window observation")
  })

  it("exposes one grant review with three levels and responsive controls", () => {
    expect(source).toContain("Observe only")
    expect(source).toContain("Assisted control")
    expect(source).toContain("Autonomous control")
    expect(source).toContain("All sessions until I stop")
    expect(source).toContain("Choose action categories")
    expect(source).toContain("Sensitive-action policy")
    expect(source).toContain("Allow this session")
    expect(source).toContain("Allow every time")
    expect(source).toContain('const exact = selected("apps") === "current"')
    expect(source).toContain('if (input.value !== "session") input.disabled = exact')
    expect(source).toContain("This exact window")
    expect(source).toContain("Allow and continue")
    expect(source).toContain('"takeover" | "resume"')
    expect(source).toContain('send(manual ? "resume" : "takeover")')
    expect(source).toContain("@media (max-width: 520px)")
  })

  it("does not capture merely because a grant review opened", () => {
    expect(source).toContain('if (message.type === "ready")')
    expect(source).toContain("await this.sync()")
    expect(source).not.toContain('["ready", "refresh", "resume"]')
  })
})
