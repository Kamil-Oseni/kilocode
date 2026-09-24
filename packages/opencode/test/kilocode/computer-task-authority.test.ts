import { describe, expect, it } from "bun:test"
import { Permission } from "@/permission"
import { TaskAuthority } from "@/kilocode/tool/task-authority"

describe("Computer Use child authority", () => {
  it("keeps filesystem mutation denied while admitting desktop tools under Auto's wildcard", () => {
    const parent = Permission.fromConfig({ "*": "deny", task: "allow", edit: "allow" })
    const child = Permission.merge(TaskAuthority.rules("computer"), TaskAuthority.denies("computer", parent))
    expect(Permission.evaluate("desktop_observe", "*", child).action).toBe("allow")
    expect(Permission.evaluate("desktop_sequence", "*", child).action).toBe("allow")
    expect(Permission.evaluate("read", "*", child).action).toBe("deny")
    expect(Permission.evaluate("write", "*", child).action).toBe("deny")
    expect(Permission.evaluate("edit", "*", child).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", child).action).toBe("deny")
    expect(TaskAuthority.permits("read", "desktop_observe", "*")).toBe(false)
    expect(TaskAuthority.permits("computer", "desktop_observe", "*")).toBe(true)
  })

  it("keeps explicit parent read denials while desktop authority uses its own grant", () => {
    const parent = Permission.fromConfig({ read: "deny", desktop_observe: "allow" })
    const child = Permission.merge(TaskAuthority.rules("computer"), TaskAuthority.denies("computer", parent))
    expect(Permission.evaluate("read", "*", child).action).toBe("deny")
    expect(Permission.evaluate("desktop_observe", "*", child).action).toBe("allow")
  })

  it("preserves a specific parent desktop denial", () => {
    const parent = Permission.fromConfig({ "*": "deny", desktop_sequence: "deny" })
    const child = Permission.merge(TaskAuthority.rules("computer"), TaskAuthority.denies("computer", parent))
    expect(Permission.evaluate("desktop_observe", "*", child).action).toBe("allow")
    expect(Permission.evaluate("desktop_sequence", "*", child).action).toBe("deny")
  })

  it("accepts only the exact persisted child lineage and grant", () => {
    const metadata = TaskAuthority.bind(TaskAuthority.save({}, "computer"), {
      parentSessionID: "session_parent",
      childSessionID: "session_child",
      grantID: "grant_one",
      windowID: "window_selected",
      identity: "process_test",
    })
    expect(TaskAuthority.proof(metadata, "session_child", "session_parent")).toMatchObject({
      grantID: "grant_one",
      windowID: "window_selected",
      identity: "process_test",
    })
    expect(() =>
      TaskAuthority.proof(
        {
          ...metadata,
          [TaskAuthority.computerKey]: {
            ...(metadata[TaskAuthority.computerKey] as object),
            windowID: "",
          },
        },
        "session_child",
        "session_parent",
      ),
    ).toThrow()
    expect(() => TaskAuthority.proof(metadata, "session_other", "session_parent")).toThrow()
    expect(() => TaskAuthority.proof(metadata, "session_child", "session_other")).toThrow()
    expect(() => TaskAuthority.proof(TaskAuthority.save({}, "computer"), "session_child", "session_parent")).toThrow()
    expect(() => TaskAuthority.select({ saved: "computer", requested: "edit", parent: [] })).toThrow()
  })

  it("does not infer computer access when a task omits access", () => {
    expect(TaskAuthority.select({ parent: Permission.fromConfig({ "*": "deny" }) })).toBeUndefined()
  })
})
