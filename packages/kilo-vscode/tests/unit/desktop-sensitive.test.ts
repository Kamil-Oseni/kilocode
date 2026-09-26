import { describe, expect, it } from "bun:test"
import { mismatch } from "../../src/services/computer-use/desktop-sensitive"
import type { DesktopAction, DesktopControl, DesktopSemantics } from "../../src/services/computer-use/desktop-session"

function semantics(controls: DesktopControl[], status: DesktopSemantics["status"] = "available"): DesktopSemantics {
  return {
    source: "windows_ui_automation",
    status,
    viewport: { x: -100, y: 50, width: 1000, height: 600 },
    controls,
    truncated: false,
  }
}

function control(name: string, input: Partial<DesktopControl> = {}): DesktopControl {
  return {
    controlID: name,
    role: "Button",
    name,
    x: 300,
    y: 200,
    width: 200,
    height: 100,
    enabled: true,
    focused: false,
    actions: ["invoke"],
    ...input,
  }
}

function click(sensitive: DesktopAction["sensitive"]): DesktopAction {
  return {
    operation: "pointer",
    action: "click",
    windowID: "window",
    observationID: "observation",
    sensitive,
    x: 0.5,
    y: 0.33,
  }
}

describe("desktop semantic sensitivity", () => {
  it("requires the category inferred from an accessible click target", () => {
    const tree = semantics([
      control("Container", { x: 0, y: 50, width: 1000, height: 600 }),
      control("Send message", { x: 350, y: 220, width: 80, height: 40 }),
    ])

    expect(mismatch(click(false), tree)).toBe(
      "Accessible desktop target semantics require sensitive_category=communications",
    )
    expect(mismatch(click("communications"), tree)).toBeUndefined()
  })

  it("does not let a neutral child hide a sensitive parent", () => {
    const tree = semantics([
      control("Delete permanently", { x: 300, y: 180, width: 200, height: 100 }),
      control("Confirm", { x: 350, y: 220, width: 80, height: 40 }),
    ])

    expect(mismatch(click(false), tree)).toBe("Accessible desktop target semantics require sensitive_category=deletion")
    expect(mismatch(click("deletion"), tree)).toBeUndefined()
  })

  it("refuses a control whose own label spans sensitive categories", () => {
    const tree = semantics([control("Pay and send")])
    expect(mismatch(click("financial"), tree)).toMatch(/multiple sensitive policy categories/i)
  })

  it("checks focused keyboard targets without inspecting typed text", () => {
    const action: DesktopAction = {
      operation: "type",
      windowID: "window",
      observationID: "observation",
      sensitive: false,
      text: "redacted from policy",
    }
    expect(
      mismatch(action, semantics([control("Password", { focused: true, role: "Edit", actions: ["value"] })])),
    ).toBe("Accessible desktop target semantics require sensitive_category=credentials")
  })

  it("does not invent semantics when UI Automation is unavailable or has no positive match", () => {
    expect(mismatch(click(false), semantics([], "unavailable"))).toBeUndefined()
    expect(mismatch(click(false), semantics([control("Continue")]))).toBeUndefined()
  })

  it("refuses a drag spanning different sensitive categories", () => {
    const action: DesktopAction = {
      operation: "drag",
      windowID: "window",
      observationID: "observation",
      sensitive: "deletion",
      startX: 0.3,
      startY: 0.3,
      endX: 0.8,
      endY: 0.3,
      button: "left",
    }
    const tree = semantics([
      control("Delete permanently", { x: 150, y: 180, width: 100, height: 100 }),
      control("Upload files", { x: 650, y: 180, width: 100, height: 100 }),
    ])
    expect(mismatch(action, tree)).toMatch(/multiple sensitive policy categories/i)
  })
})
