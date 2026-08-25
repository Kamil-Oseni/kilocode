// raya_change - Milestone A /goal parsing contract
import { describe, expect, it } from "bun:test"
import { goalPrompt, parseGoalCommand } from "../../src/shared/goal"

describe("native goal command", () => {
  it("prints usage for an empty objective", () => {
    expect(parseGoalCommand("/goal")).toEqual({
      kind: "usage",
      notice: "Usage: /goal <objective>",
    })
  })

  it("strips unsupported leading time limits without weakening the objective", () => {
    expect(parseGoalCommand("/goal 30m make the tests green")).toEqual({
      kind: "start",
      objective: "make the tests green",
      notice: "Time-limited goals are not supported yet. The 30m limit was removed.",
    })
    expect(parseGoalCommand("/goal 2h prove reload persistence")).toEqual({
      kind: "start",
      objective: "prove reload persistence",
      notice: "Time-limited goals are not supported yet. The 2h limit was removed.",
    })
  })

  it("requires concrete work and a real evidence audit in the same turn", () => {
    const text = goalPrompt("ship goal mode")
    expect(text).toContain("first concrete unit of work now in this same turn")
    expect(text).toContain("call get_goal")
    expect(text).toContain('update_goal(status="complete")')
    expect(text).toContain("real successful tool calls")
    expect(text).toContain('update_goal(status="blocked")')
  })
})
