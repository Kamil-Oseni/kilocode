// raya_change - smooth browser takeover panel contract
import { describe, expect, it } from "bun:test"

const source = await Bun.file(new URL("../../src/services/browser-automation/browser-panel.ts", import.meta.url)).text()

describe("Raya browser takeover panel", () => {
  it("shows live attempt state and an explicit resume control", () => {
    expect(source).toContain('id="status"')
    expect(source).toContain('id="resume"')
    expect(source).toContain('attempt " + state.attempts + " of 3')
    expect(source).toContain('send("resume")')
  })

  it("locks panel input while an agent action is in progress", () => {
    expect(source).toContain('id="shield"')
    expect(source).toContain("[hidden] { display: none !important; }")
    expect(source).toContain('id="takeover"')
    expect(source).toContain('send("takeover")')
    expect(source).toContain("control.disabled = state.busy && !manual")
    expect(source).toContain("shield.hidden = manual || !state.busy")
  })

  it("supports Enter and an explicit Go button for manual navigation", () => {
    expect(source).toContain('id="go"')
    expect(source).toContain('go.addEventListener("click", visit)')
    expect(source).toContain("event.preventDefault();")
    expect(source).toContain("url.blur();")
  })
})
