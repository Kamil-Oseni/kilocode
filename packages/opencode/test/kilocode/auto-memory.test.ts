import { expect, test } from "bun:test"
import { addAuto } from "@/kilocode/agent"
import { Permission } from "@/permission"
import { RayaChief } from "@/kilocode/chief"

test("Auto exposes approved read-only Memory without granting note writes or overriding a user deny", () => {
  const agents: Parameters<typeof addAuto>[0] = {}
  addAuto(agents, Permission.fromConfig({}))
  expect(Permission.evaluate("second_brain_recall", "*", agents.auto.permission).action).toBe("allow")
  expect(Permission.evaluate("second_brain_proposal", "*", agents.auto.permission).action).toBe("deny")
  const denied: Parameters<typeof addAuto>[0] = {}
  addAuto(denied, Permission.fromConfig({}), undefined, Permission.fromConfig({ second_brain_recall: "deny" }))
  expect(Permission.evaluate("second_brain_recall", "*", denied.auto.permission).action).toBe("deny")
  const available = {
    chief_route: true,
    second_brain_recall: true,
    second_brain_proposal: true,
    bash: true,
    get_goal: true,
  }
  for (const phase of ["route", "task", "goal", "done"]) {
    const tools = RayaChief.tools(available, { [RayaChief.phaseKey]: phase })
    expect(tools.second_brain_recall).toBe(true)
    expect("second_brain_proposal" in tools).toBe(false)
    expect("bash" in tools).toBe(false)
  }
  expect(RayaChief.tools(available, { [RayaChief.phaseKey]: "verify" })).toEqual({ get_goal: true })
})
