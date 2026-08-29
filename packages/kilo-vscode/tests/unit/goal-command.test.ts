// raya_change - Milestone A /goal parsing contract
import { describe, expect, it } from "bun:test"
import { goalPrompt, hasGoalIntent, parseGoalCommand } from "../../src/shared/goal"

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

  // raya_change start - /goal anywhere in the message, not only leading
  it("arms a goal when /goal is placed after or inside the sentence", () => {
    expect(parseGoalCommand("make the tests green /goal")).toMatchObject({
      kind: "start",
      objective: "make the tests green",
      notice: expect.stringContaining("/goal command"),
    })
    expect(parseGoalCommand("ship /goal the provider hub")).toMatchObject({
      kind: "start",
      objective: "ship the provider hub",
    })
  })

  it("does not treat a path-like token as the /goal command", () => {
    expect(parseGoalCommand("update packages/goal/index.ts")).toBeUndefined()
  })
  // raya_change end

  it("requires concrete work and a real evidence audit in the same turn", () => {
    const text = goalPrompt("ship goal mode")
    expect(text).toContain("first concrete unit of work now in this same turn")
    expect(text).toContain("call get_goal")
    expect(text).toContain('update_goal(status="complete")')
    expect(text).toContain("real successful tool calls")
    expect(text).toContain('update_goal(status="blocked")')
  })

  // raya_change start - plain-English durable work should not require remembering /goal
  it("infers durable goal intent from ordinary completion language", () => {
    const prompts = [
      "Keep working until the checkout flow passes every test.",
      "Do not stop until reload persistence is fully verified.",
      "Implement the provider hub. Done when the connection and persistence checks pass.",
      "Make this a goal: finish the migration and prove it is green.",
      "Finish the browser integration completely and verify every requirement.",
    ]

    for (const prompt of prompts) {
      expect(hasGoalIntent(prompt)).toBe(true)
      expect(parseGoalCommand(prompt)).toMatchObject({
        kind: "start",
        objective: prompt,
        notice: expect.stringContaining("durable goal work"),
      })
    }
  })

  it("does not turn routine questions or bounded edits into persistent goals", () => {
    for (const prompt of [
      "Explain how routing works.",
      "Fix the typo in the README.",
      "Open example.com and tell me its title.",
      "Which database would you recommend?",
    ]) {
      expect(hasGoalIntent(prompt)).toBe(false)
      expect(parseGoalCommand(prompt)).toBeUndefined()
    }
  })
  // raya_change end
})
