import { expect, test } from "bun:test"
import { openFullAccess } from "../../src/kilocode/agent"
import { Permission } from "../../src/permission"

// The restrictive ceiling these agents carried before the tear-out: deny everything except a
// small allowlist.
function readOnlyAgent(name: string) {
  return {
    name,
    permission: Permission.fromConfig({
      "*": "deny",
      bash: { "*": "deny", "ls *": "allow" },
      read: "allow",
      edit: "deny",
    }),
  }
}

// A minimal stand-in for the default agent recipe: bash asks, external asks, everything else allowed.
const defaults = Permission.fromConfig({ "*": "allow", bash: "ask", external_directory: "ask", doom_loop: "ask" })
const user = Permission.fromConfig({ bash: { "*": "allow" } })

test("openFullAccess gives Plan, Ask, Explore, Orchestrator, and Voice full tool access", () => {
  const agents = {
    plan: readOnlyAgent("plan"),
    ask: readOnlyAgent("ask"),
    explore: readOnlyAgent("explore"),
    orchestrator: readOnlyAgent("orchestrator"),
    voice: readOnlyAgent("voice"),
  }
  openFullAccess(agents, { agent: {} } as never, defaults, user)
  for (const key of ["plan", "ask", "explore", "orchestrator", "voice"] as const) {
    const rules = agents[key].permission
    expect(Permission.evaluate("edit", "src/x.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("write", "src/x.ts", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "general", rules).action).toBe("allow")
    expect(Permission.evaluate("websearch", "*", rules).action).toBe("allow")
    // The user's global bash allow layers on top of the default bash ask.
    expect(Permission.evaluate("bash", "bun test", rules).action).toBe("allow")
  }
})

test("openFullAccess leaves other agents untouched", () => {
  const agents = { code: readOnlyAgent("code") }
  openFullAccess(agents, { agent: {} } as never, defaults, user)
  expect(Permission.evaluate("edit", "src/x.ts", agents.code.permission).action).toBe("deny")
})

test("a user's own per-agent deny still wins over the full-access base", () => {
  const agents = { plan: readOnlyAgent("plan") }
  openFullAccess(agents, { agent: { plan: { permission: { edit: "deny" } } } } as never, defaults, user)
  expect(Permission.evaluate("edit", "src/x.ts", agents.plan.permission).action).toBe("deny")
  expect(Permission.evaluate("bash", "bun test", agents.plan.permission).action).toBe("allow")
})
