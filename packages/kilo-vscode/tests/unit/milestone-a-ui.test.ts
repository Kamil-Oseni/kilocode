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
    const goal = host.indexOf("const command = parseGoalCommand(text)")
    expect(host.indexOf("this.client.kilocode.goal.create", goal)).toBeLessThan(
      host.indexOf("this.client!.session.promptAsync", goal),
    )
  })

  it("separates goal lifecycle controls from chat-level change review", async () => {
    const banner = await Bun.file(path.join(root, "webview-ui/src/components/chat/GoalBanner.tsx")).text()
    const chat = await Bun.file(path.join(root, "webview-ui/src/components/chat/ChatView.tsx")).text()
    const host = await Bun.file(path.join(root, "src/KiloProvider.ts")).text()
    const styles = await Bun.file(path.join(root, "webview-ui/src/styles/banners.css")).text()
    const user = await Bun.file(path.join(root, "webview-ui/src/components/chat/VscodeUserMessage.tsx")).text()
    const parts = await Bun.file(path.join(root, "../kilo-ui/src/components/message-part.tsx")).text()
    const partStyles = await Bun.file(path.join(root, "../kilo-ui/src/components/message-part.css")).text()

    expect(banner).toContain('type: "goalGet"')
    expect(banner).toContain("state().blockedReason")
    expect(banner).toContain("session.todos()")
    expect(banner).toContain("Math.round((done() / props.todos.length) * 100)")
    expect(banner).toContain("goal.activeMs")
    expect(banner).toContain("Stop goal")
    expect(banner).toContain("Update the goal")
    expect(banner).toContain("The current step keeps running")
    expect(banner).toContain("const [draft, setDraft]")
    expect(banner).toContain("onInput={(event) => setDraft(event.currentTarget.value)}")
    expect(banner).not.toContain("editor.value = props.goal.objective")
    expect(banner).toContain("Stop tracking this goal?")
    expect(banner).toContain("Existing edits will remain available")
    expect(banner).not.toContain('type: "openChanges"')
    expect(banner).not.toContain('type: "goalDiscard"')
    expect(chat).toContain("canReviewChanges")
    expect(chat).toContain("session.reviewStats()")
    expect(chat).toContain('class="session-review-label">Review changes</span>')
    expect(chat).toContain('vscode.postMessage({ type: "openChanges" })')
    expect(chat).toContain("Keep all")
    expect(chat).toContain("Undo all")
    expect(chat).toContain("session-review-cluster")
    expect(chat).toContain("Confirm undo")
    // raya_change - Undo all discards file edits only; it must NOT revert the session
    // (which would delete the conversation and offer a nonsensical redo).
    expect(chat).toContain('type: "discardSessionChanges"')
    expect(chat).not.toContain("session.revertSession(first.id)")
    expect(host).toContain("sessionSourceId(sessionId)")
    expect(host).toContain("type: \"reviewStatsLoaded\"")
    expect(host).toContain("this.client.session.diff")
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
