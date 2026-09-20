import { describe, expect, it } from "bun:test"
import { report } from "../../src/agent-manager/webview-error"

describe("Agent Manager webview errors", () => {
  it("ignores unrelated messages", () => {
    const messages: string[] = []
    expect(report({ type: "webviewReady" }, (message) => messages.push(message))).toBe(false)
    expect(messages).toEqual([])
  })

  it("bounds diagnostics before logging them", () => {
    const messages: string[] = []
    expect(
      report({ type: "agentManager.webviewError", source: "s".repeat(40), message: "m".repeat(5_000) }, (message) =>
        messages.push(message),
      ),
    ).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toBe(`Webview ${"s".repeat(32)} failure: ${"m".repeat(4_000)}`)
  })
})
