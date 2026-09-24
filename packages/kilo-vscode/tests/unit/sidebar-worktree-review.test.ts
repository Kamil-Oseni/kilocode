import { describe, expect, test } from "bun:test"
import { handleSidebarWorktreeMessage } from "../../src/kilo-provider/sidebar-worktree"

describe("sidebar changes scope", () => {
  test("keeps the session directory while requesting the workspace source", async () => {
    const calls: Array<{ session?: string; turn?: string; scope?: "workspace" }> = []
    const ctx = {
      post: () => {},
      openAgentManager: async () => {},
      openAdvancedWorktree: async () => {},
      openChanges: async (session?: string, turn?: string, scope?: "workspace") => {
        calls.push({ session, turn, scope })
      },
      openProfile: async () => {},
      currentSessionId: "session-a",
    }

    expect(await handleSidebarWorktreeMessage({ type: "openChanges", scope: "workspace" }, ctx)).toBe(true)
    expect(await handleSidebarWorktreeMessage({ type: "openChanges" }, ctx)).toBe(true)
    expect(calls).toEqual([
      { session: "session-a", turn: undefined, scope: "workspace" },
      { session: "session-a", turn: undefined, scope: undefined },
    ])
  })
})
