import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"
import { RayaTask } from "@/kilocode/task"

describe("task selected question permission", () => {
  for (const access of ["brief", "full"] as const) {
    test(`${access}: excluded question stays denied without changing goal permissions`, () => {
      const rules = RayaTask.rules({ role: "generalist", access, tools: ["read", "get_goal", "update_goal"] })
      expect(Permission.evaluate("question", "*", rules).action).toBe("deny")
      for (const name of ["read", "get_goal", "update_goal", "update_goal_plan"])
        expect(Permission.evaluate(name, "*", rules).action).toBe("allow")
      for (const name of ["bash", "edit"]) expect(Permission.evaluate(name, "*", rules).action).toBe("deny")
    })
    test(`${access}: empty selection denies question`, () => {
      const rules = RayaTask.rules({ role: "generalist", access, tools: [] })
      expect(Permission.evaluate("question", "*", rules).action).toBe("deny")
    })
    for (const name of ["question", "ques*", "*"]) {
      test(`${access}: explicit ${name} selection allows question`, () => {
        const rules = RayaTask.rules({ role: "generalist", access, tools: [name] })
        expect(Permission.evaluate("question", "*", rules).action).toBe("allow")
      })
    }
    test(`${access}: default selection retains question`, () => {
      const rules = RayaTask.rules({ role: "generalist", access })
      expect(Permission.evaluate("question", "*", rules).action).toBe("allow")
    })
  }
  test("implicit briefer selection also excludes question", () => {
    const rules = RayaTask.rules({ role: "briefer", tools: ["read"] })
    expect(Permission.evaluate("question", "*", rules).action).toBe("deny")
    expect(Permission.evaluate("read", "*", rules).action).toBe("allow")
  })
})
