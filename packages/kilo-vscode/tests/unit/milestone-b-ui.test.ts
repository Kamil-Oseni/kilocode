// raya_change - Milestone B selectable Auto mode contract
import { describe, expect, it } from "bun:test"
import path from "path"
import { filterVisibleAgents } from "../../src/kilo-provider-utils"

describe("Milestone B Auto UI", () => {
  it("passes the native Auto primary agent into the chat mode selector", async () => {
    const agents = [
      { name: "auto", mode: "primary", native: true, description: "Intelligent routing" },
      { name: "coder", mode: "subagent", native: true, description: "Coding specialist" },
    ] as Parameters<typeof filterVisibleAgents>[0]
    const { visible } = filterVisibleAgents(agents)
    const source = await Bun.file(
      path.join(__dirname, "../../webview-ui/src/components/shared/ModeSwitcher.tsx"),
    ).text()

    expect(visible.map((item) => item.name)).toEqual(["auto"])
    expect(source).toContain("agents={session.agents()}")
    expect(source).toContain("<For each={props.agents}>")
    expect(source).toContain("formatAgentLabel(agent)")
  })
})
