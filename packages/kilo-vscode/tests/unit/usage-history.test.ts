// raya_change - historical model token and cost tracker integration contract
import { describe, expect, it } from "bun:test"
import path from "node:path"

const root = path.join(import.meta.dir, "../..")

describe("model usage history", () => {
  it("requests selectable project ranges and renders per-model token cost rows", async () => {
    const view = await Bun.file(path.join(root, "webview-ui/src/components/chat/UsageHistory.tsx")).text()
    const host = await Bun.file(path.join(root, "src/KiloProvider.ts")).text()
    const sdk = await Bun.file(path.join(root, "../sdk/js/src/v2/gen/sdk.gen.ts")).text()

    for (const range of ["24h", "7d", "30d", "all"]) expect(view).toContain(`value: "${range}"`)
    expect(view).toContain('type: "requestProjectUsage"')
    expect(view).toContain('message.type !== "projectUsageLoaded"')
    expect(view).toContain("modelUsageName(model")
    expect(view).toContain("formatCompactCount(tokens(model))")
    expect(host).toContain("client.kilocode.projectUsage({ directory, range }")
    expect(sdk).toContain("public projectUsage")
  })

  it("uses the runtime queue event before transcript inference", async () => {
    const host = await Bun.file(path.join(root, "src/KiloProvider.ts")).text()
    const session = await Bun.file(path.join(root, "webview-ui/src/context/session.tsx")).text()
    const list = await Bun.file(path.join(root, "webview-ui/src/components/chat/MessageList.tsx")).text()

    expect(host).toContain('event.type === "session.queue.changed"')
    expect(host).toContain('type: "sessionQueueChanged"')
    expect(session).toContain('message.type === "sessionQueueChanged"')
    expect(list).toContain("const queued = session.queuedMessages()")
    expect(list.indexOf("if (queued) return new Set(queued)")).toBeLessThan(list.indexOf("queuedUserMessageIDs("))
  })

  it("exposes existing control surfaces through discoverable slash commands", async () => {
    const input = await Bun.file(path.join(root, "webview-ui/src/components/chat/PromptInput.tsx")).text()
    const header = await Bun.file(path.join(root, "webview-ui/src/components/chat/TaskHeader.tsx")).text()

    for (const command of ["plan", "status", "changes", "fork", "side", "worktree"]) {
      expect(input).toContain(`name: "${command}"`)
    }
    expect(input).toContain('session.selectAgent("plan", sid())')
    expect(input).toContain('type: "continueInWorktree"')
    expect(input).toContain('type: "forkSession"')
    expect(header).toContain('window.addEventListener("showTaskStatus", showStatus)')
  })
})
