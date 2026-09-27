import { describe, expect, it } from "bun:test"
import { Permission } from "@/permission"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { addAuto } from "@/kilocode/agent"
import { RayaChief } from "@/kilocode/chief"

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

  it("decodes exact version-two window bindings and rejects malformed restart metadata", () => {
    const binding = { version: 1 as const, windowID: "0x123", identity: "A".repeat(64) }
    const metadata = TaskAuthority.bindSelected(TaskAuthority.save({}, "computer"), {
      parentSessionID: "session_parent",
      childSessionID: "session_child",
      grantID: "grant_one",
      binding,
    })
    expect(TaskAuthority.proof(metadata, "session_child", "session_parent")).toMatchObject({
      grantID: "grant_one",
      windowID: "0x123",
      identity: binding.identity,
    })
    for (const changed of [
      { ...binding, windowID: "0xBAD`" },
      { ...binding, identity: "B".repeat(63) },
      { ...binding, version: 2 },
    ])
      expect(() =>
        TaskAuthority.proof(
          {
            ...metadata,
            [TaskAuthority.computerKey]: { ...(metadata[TaskAuthority.computerKey] as object), binding: changed },
          },
          "session_child",
          "session_parent",
        ),
      ).toThrow()
    expect(() => TaskAuthority.proof(metadata, "session_other", "session_parent")).toThrow()
    expect(() => TaskAuthority.proof(metadata, "session_child", "session_other")).toThrow()
  })

  it("does not infer computer access when a task omits access", () => {
    expect(TaskAuthority.select({ parent: Permission.fromConfig({ "*": "deny" }) })).toBeUndefined()
  })

  it("makes a new unplanned Auto inspection child read-only without changing legacy callers", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    const read = TaskAuthority.admit({ auto: true, goalActive: false, parent })
    const metadata = TaskAuthority.save({}, read)
    const child = Permission.merge(TaskAuthority.rules(read), TaskAuthority.denies(read, parent))
    expect(TaskAuthority.read(metadata)).toBe("read")
    expect(Permission.evaluate("read", "*", child).action).toBe("allow")
    expect(Permission.evaluate("write", "*", child).action).toBe("deny")
    expect(Permission.evaluate("edit", "*", child).action).toBe("deny")
    expect(Permission.evaluate("bash", "*", child).action).toBe("deny")
    expect(TaskAuthority.admit({ auto: false, goalActive: false, parent })).toBeUndefined()
    expect(TaskAuthority.admit({ auto: true, goalActive: false, parent })).toBe("read")
  })

  it("lets an Auto inspection child read while keeping the coordinator tool list curated", () => {
    const agents: Parameters<typeof addAuto>[0] = {}
    addAuto(agents, Permission.fromConfig({}))
    const parent = agents.auto?.permission ?? []
    const child = Permission.merge(TaskAuthority.rules("read"), TaskAuthority.denies("read", parent))
    expect(Permission.evaluate("read", "*", child).action).toBe("allow")
    expect(Permission.evaluate("grep", "*", child).action).toBe("allow")
    expect(Permission.evaluate("chief_message", "*", child).action).toBe("allow")
    expect(Permission.evaluate("edit", "*", child).action).toBe("deny")
    expect(Object.keys(RayaChief.tools({ read: true, chief_route: true, task: true }, undefined))).toEqual([
      "chief_route",
    ])
  })

  it("admits an unplanned Auto edit for the exact current user request with parent permission", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    const request = "Commit and push all changes"
    expect(TaskAuthority.current(request, request)).toBe(true)
    expect(
      TaskAuthority.current(
        "There was also an issue where the agent couldn't work after the goal was completed, which shouldn't be so",
        "There was also an issue where the agent couldn't work after the goal was completed, which shouldn't be so",
      ),
    ).toBe(true)
    expect(TaskAuthority.current("I want Raya to fix the history view", "I want Raya to fix the history view")).toBe(
      true,
    )
    expect(TaskAuthority.admit({ auto: true, requested: "edit", goalActive: false, userEdit: true, parent })).toBe(
      "edit",
    )
    expect(TaskAuthority.admit({ auto: true, saved: "edit", goalActive: false, userEdit: true, parent })).toBe("edit")
    const files =
      "This is a new disposable test after the completed arithmetic goal. In the current dummy workspace, use two parallel editing specialists: one creates raya-review-fresh-a.txt containing exactly fresh worker A; the other creates raya-review-fresh-b.txt containing exactly fresh worker B. Wait for both, verify each file once, and give one final answer. Do not change or reopen the old goal, ask a question, or edit any other file."
    expect(TaskAuthority.current(files, files)).toBe(true)
    expect(TaskAuthority.admit({ auto: true, requested: "edit", goalActive: false, userEdit: true, parent })).toBe(
      "edit",
    )
    expect(TaskAuthority.current(files, "Authorize the two file creations now")).toBe(false)
    expect(TaskAuthority.current(files, "Hold — do not create the files")).toBe(false)
    expect(TaskAuthority.current(files, "Stop here — no files to create")).toBe(false)
    expect(TaskAuthority.explicit("Authorize the two file creations now")).toBe(false)
    expect(TaskAuthority.explicit("Hold — do not create the files")).toBe(false)
    expect(TaskAuthority.explicit("Stop here — no files to create")).toBe(false)
    expect(() =>
      TaskAuthority.admit({
        auto: true,
        requested: "edit",
        goalActive: false,
        userEdit: true,
        parent: Permission.fromConfig({ edit: "deny" }),
      }),
    ).toThrow("parent policy")
  })

  it("does not inherit edit authority from an old or non-mutating request", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    expect(TaskAuthority.current("Commit and push all changes", "Review the latest changes")).toBe(false)
    expect(TaskAuthority.current("Do not commit these changes", "Do not commit these changes")).toBe(false)
    expect(TaskAuthority.current("Review the changes", "Review the changes")).toBe(false)
    expect(TaskAuthority.current("Review how to fix this bug", "Review how to fix this bug")).toBe(false)
    expect(TaskAuthority.current("Review and fix this bug", "Review and fix this bug")).toBe(true)
    expect(TaskAuthority.current("Review only, no edits: fix nothing", "Review only, no edits: fix nothing")).toBe(
      false,
    )
    expect(
      TaskAuthority.current(
        "Create the named file; do not edit any other file",
        "Create the named file; do not edit any other file",
      ),
    ).toBe(true)
    expect(
      TaskAuthority.current("Create the named file; no edits outside it", "Create the named file; no edits outside it"),
    ).toBe(true)
    expect(
      TaskAuthority.current(
        "Do not reopen the old goal; create the named file",
        "Do not reopen the old goal; create the named file",
      ),
    ).toBe(true)
    expect(
      TaskAuthority.current(
        "Create the named file; do not edit anything",
        "Create the named file; do not edit anything",
      ),
    ).toBe(false)
    expect(
      TaskAuthority.current(
        "Create the named file; without editing the workspace",
        "Create the named file; without editing the workspace",
      ),
    ).toBe(false)
    for (const request of [
      "Write a summary of this file",
      "Create a summary of the project code",
      "Write a report explaining how to fix this bug",
      "Write a report and explain how to fix this bug",
      "Write a report about docs/readme.md",
      "Write a summary of package.json",
      "Write a summary and create a plan",
      "Create a plan for the next release",
      "Write me an email about the changes",
    ]) {
      expect(TaskAuthority.current(request, request)).toBe(false)
    }
    for (const request of [
      "Write a summary in a file",
      "Create a report at docs/report.md",
      "Write a summary and fix this bug",
      "Create a plan, then implement it",
    ]) {
      expect(TaskAuthority.current(request, request)).toBe(true)
    }
    expect(() => TaskAuthority.admit({ auto: true, requested: "edit", goalActive: false, parent })).toThrow(
      "explicit current user request",
    )
    expect(() => TaskAuthority.admit({ auto: true, saved: "edit", goalActive: false, parent })).toThrow(
      "explicit current user request",
    )
  })

  it("treats an in-turn Ask hold or dismissal as revoking edit authority", () => {
    expect(
      TaskAuthority.declined({
        answers: [
          { prompt: "Create these files?", selected: [{ id: "authorize", label: "Authorize now" }], other: [] },
        ],
      }),
    ).toBe(false)
    expect(
      TaskAuthority.declined({
        answers: [
          { prompt: "Create these files?", selected: [{ id: "hold", label: "Hold — do not create" }], other: [] },
        ],
      }),
    ).toBe(true)
    expect(
      TaskAuthority.declined({
        answers: [{ prompt: "Continue?", selected: [{ id: "stop", label: "Stop here — no files" }], other: [] }],
      }),
    ).toBe(true)
    expect(TaskAuthority.declined({ answers: [{ selected: [], other: ["Cancel this edit"] }] })).toBe(false)
    expect(TaskAuthority.declined({ terminal: true, answers: [{ selected: [], other: [] }] })).toBe(true)
    expect(TaskAuthority.declined({ answers: [], dismissed: true })).toBe(true)
    expect(TaskAuthority.declined({ answers: [{ selected: [], other: ["Use the requested names"] }] })).toBe(false)
    expect(
      TaskAuthority.declined({
        answers: [{ selected: [{ id: "authorize", label: "No problem, proceed" }], other: [] }],
      }),
    ).toBe(false)
    expect(TaskAuthority.declined({ answers: "hold" })).toBe(false)
  })

  it("admits single Auto edits with an active goal and explicit parent editing permission", () => {
    const parent = Permission.fromConfig({ "*": "allow" })
    expect(TaskAuthority.admit({ auto: true, requested: "edit", goalActive: true, parent })).toBe("edit")
    expect(() =>
      TaskAuthority.admit({
        auto: true,
        requested: "edit",
        goalActive: true,
        parent: Permission.fromConfig({ edit: "deny" }),
      }),
    ).toThrow("parent policy")
  })
})
