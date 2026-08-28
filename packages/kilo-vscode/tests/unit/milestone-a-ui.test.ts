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

  it("shows compact status, real work progress, steering, and review controls", async () => {
    const banner = await Bun.file(path.join(root, "webview-ui/src/components/chat/GoalBanner.tsx")).text()
    const host = await Bun.file(path.join(root, "src/KiloProvider.ts")).text()
    const styles = await Bun.file(path.join(root, "webview-ui/src/styles/banners.css")).text()
    const user = await Bun.file(path.join(root, "webview-ui/src/components/chat/VscodeUserMessage.tsx")).text()
    const parts = await Bun.file(path.join(root, "../kilo-ui/src/components/message-part.tsx")).text()
    const partStyles = await Bun.file(path.join(root, "../kilo-ui/src/components/message-part.css")).text()

    expect(banner).toContain('type: "goalGet"')
    expect(banner).toContain("state().blockedReason")
    expect(banner).toContain("session.todos()")
    expect(banner).toContain("Update the goal")
    expect(banner).toContain("The current step keeps running")
    expect(banner).toContain('type: "openChanges"')
    expect(banner).toContain("turnId: start()")
    expect(banner).toContain("Confirm discard")
    expect(banner).toContain('type: "goalDiscard"')
    expect(banner).not.toContain("session.revertSession(start)")
    expect(banner).toContain('session.status() !== "idle"')
    expect(host).toContain('message.type === "goalDiscard"')
    expect(host.indexOf("await this.handleRevertSession(sid, id)")).toBeLessThan(
      host.indexOf('await this.handleGoalControl(sid, "clear")'),
    )
    expect(banner).toContain('act("pause")')
    expect(banner).toContain('act("resume")')
    expect(banner).toContain('act("clear")')
    expect(banner).toContain('act("revise", objective)')
    expect(styles).toContain("-webkit-line-clamp: 2")
    expect(styles).toContain("max-height: var(--goal-detail-max)")
    expect(styles).not.toContain("goal-dot-breathe")
    expect(user).toContain('toggleLabel={expanded() ? "Show less" : "Show full prompt"}')
    expect(parts).toContain('data-collapsed={props.collapsed ? "" : undefined}')
    expect(partStyles).toContain("&[data-collapsed]")
  })
})
