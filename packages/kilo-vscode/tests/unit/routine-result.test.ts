import { describe, expect, test } from "bun:test"
import { routineDestination, routineTarget, routineTitle } from "../../webview-ui/src/components/chat/routine-result"

const agent = "11111111-2222-4333-8444-555555555555"
const organization = `org_${"a".repeat(32)}`

describe("main-chat Routine results", () => {
  test("labels each provisioning action in product language", () => {
    expect(routineTitle("schedule_task")).toBe("Create routine")
    expect(routineTitle("create_organization")).toBe("Create organization")
    expect(routineTitle("update_routine")).toBe("Update routine")
    expect(routineTitle("update_organization")).toBe("Update organization")
  })

  test("registers single-routine creation with the Routine result renderer", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/components/chat/VscodeToolOverrides.tsx", import.meta.url),
    ).text()
    expect(source).toContain('const ROUTINE_TOOLS = ["schedule_task",')
    expect(source).toContain("ToolRegistry.register({ name, render: RoutineResultTool })")
  })

  test("opens the exact completed routine or organization", () => {
    expect(routineTarget("completed", { view: "routines", agentID: agent })).toEqual({
      organizationID: undefined,
      agentID: agent,
    })
    expect(routineTarget("completed", { view: "routines", organizationID: organization })).toEqual({
      organizationID: organization,
      agentID: undefined,
    })
  })

  test("refuses pending, unrelated, missing, and malformed destinations", () => {
    expect(routineTarget("running", { view: "routines", agentID: agent })).toBeUndefined()
    expect(routineTarget("completed", { view: "todo", agentID: agent })).toBeUndefined()
    expect(routineTarget("completed", { view: "routines" })).toBeUndefined()
    expect(routineTarget("completed", { view: "routines", agentID: ` ${agent}` })).toBeUndefined()
    expect(
      routineTarget("completed", { view: "routines", agentID: "------------------------------------" }),
    ).toBeUndefined()
    expect(routineDestination({ agentID: "11111111-2222-0333-8444-555555555555" })).toBeUndefined()
    expect(routineTarget("completed", { view: "routines", organizationID: "org_bad" })).toBeUndefined()
  })
})
