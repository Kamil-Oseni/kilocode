// raya_change - Milestone A chat and goal UI integration contract
import { describe, expect, it } from "bun:test"
import path from "path"

const root = path.join(__dirname, "../..")

describe("Milestone A goal UI", () => {
  it("parses /goal in the composer and arms it before prompting the model", async () => {
    const input = await Bun.file(path.join(root, "webview-ui/src/components/chat/PromptInput.tsx")).text()
    const host = await Bun.file(path.join(root, "src/KiloProvider.ts")).text()
    const slash = await Bun.file(path.join(root, "webview-ui/src/hooks/useSlashCommand.ts")).text()

    expect(input).toContain("parseGoalCommand(draft)")
    expect(input).toContain('command.name !== "goal"')
    expect(input).toContain('new CustomEvent("rayaGoalNotice"')
    expect(slash).toContain('name: "goal"')
    expect(host).toContain("parseGoalCommand(text)")
    expect(host).toContain("this.client.kilocode.goal.create")
    expect(host).toContain("goalPrompt(command.objective)")
    expect(host.indexOf("this.client.kilocode.goal.create")).toBeLessThan(
      host.indexOf("this.client!.session.promptAsync"),
    )
  })

  it("shows persisted status, block reasons, progress, and all user controls", async () => {
    const banner = await Bun.file(path.join(root, "webview-ui/src/components/chat/GoalBanner.tsx")).text()

    expect(banner).toContain('type: "goalGet"')
    expect(banner).toContain("state().blockedReason")
    expect(banner).toContain("state().usage.continuations")
    expect(banner).toContain('act("pause")')
    expect(banner).toContain('act("resume")')
    expect(banner).toContain('act("clear")')
  })
})
