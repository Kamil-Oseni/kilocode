import { describe, expect, it } from "bun:test"
import type { Part, ToolPart } from "@kilocode/sdk/v2"
import { toolDefaultOpen } from "../../webview-ui/src/components/chat/tool-default-open"

function tool(name: string) {
  return { type: "tool", tool: name } as ToolPart
}

describe("toolDefaultOpen", () => {
  it.each(["bash", "background_process"])("uses the terminal preference for %s", (name) => {
    expect(toolDefaultOpen(tool(name), false, true)).toBe(false)
    expect(toolDefaultOpen(tool(name), true, false)).toBe(true)
    expect(toolDefaultOpen(tool(name), true, false, false)).toBe(true)
  })

  it.each(["edit", "write", "apply_patch"])("uses the code edit preference for %s", (name) => {
    expect(toolDefaultOpen(tool(name), true, false)).toBe(false)
    expect(toolDefaultOpen(tool(name), false, true)).toBe(true)
    expect(toolDefaultOpen(tool(name), false, true, false)).toBe(true)
  })

  it.each([
    "slack_post_message",
    "github_create_issue",
    "discord_search_messages",
    "list_mcp_resources",
    "custom_mcp_tool",
  ])("uses the mcp preference for %s", (name) => {
    expect(toolDefaultOpen(tool(name), false, false, true)).toBe(true)
    expect(toolDefaultOpen(tool(name), true, true, false)).toBe(false)
    expect(toolDefaultOpen(tool(name), true, true)).toBeUndefined()
  })

  it.each(["read", "glob", "grep", "task"])("keeps %s compact regardless of the MCP preference", (name) => {
    expect(toolDefaultOpen(tool(name), true, true, true)).toBe(false)
    expect(toolDefaultOpen(tool(name), false, false, false)).toBe(false)
    expect(toolDefaultOpen(tool(name), true, true)).toBe(false)
  })

  it.each(["question", "suggest", "plan_exit"])("keeps the actionable %s card visible", (name) => {
    expect(toolDefaultOpen(tool(name), false, false, false)).toBe(true)
    expect(toolDefaultOpen(tool(name), true, true, true)).toBe(true)
  })

  it("leaves non-tool parts unchanged", () => {
    expect(toolDefaultOpen({ type: "text" } as Part, true, true, true)).toBeUndefined()
  })
})
