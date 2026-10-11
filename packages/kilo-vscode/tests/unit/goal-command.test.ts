// raya_change - Milestone A /goal parsing contract
import { describe, expect, it } from "bun:test"
import { goalPrompt, hasGoalIntent, parseGoalCommand } from "../../src/shared/goal"

describe("native goal command", () => {
  it("prints usage for an empty objective", () => {
    expect(parseGoalCommand("/goal")).toEqual({
      kind: "usage",
      notice: "Usage: /goal [30m] <objective>",
    })
  })

  it("retains leading active-time limits as an enforceable goal budget", () => {
    expect(parseGoalCommand("/goal 30m make the tests green")).toEqual({
      kind: "start",
      objective: "make the tests green",
      budget: { activeMs: 1_800_000 },
      notice: "Active-time limit saved: 30m. Raya will pause before starting more work after the limit is reached.",
    })
    expect(parseGoalCommand("/goal 2h prove reload persistence")).toEqual({
      kind: "start",
      objective: "prove reload persistence",
      budget: { activeMs: 7_200_000 },
      notice: "Active-time limit saved: 2h. Raya will pause before starting more work after the limit is reached.",
    })
    expect(parseGoalCommand("/goal 9000h exceed the limit")).toEqual({
      kind: "usage",
      notice: "Choose an active-time limit between 1 minute and 1 year. Usage: /goal [30m] <objective>",
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
    expect(goalPrompt("ship within the limit", { activeMs: 60_000 })).toContain("60000 milliseconds")
    expect(goalPrompt("recover within the limit", { recoveryAttempts: 2 })).toContain(
      "Automatic recovery-attempt limit: 2 consecutive attempts",
    )
    expect(goalPrompt("delegate within the limit", { concurrentChildren: 3 })).toContain("Concurrent-child limit: 3")
    expect(goalPrompt("delegate within the limit", { concurrentChildren: 3 })).toContain(
      "Reserve a slot before creating a delegated child",
    )
    expect(
      goalPrompt("reserve billed work", {
        chargeCosts: [{ currency: "USD", limit: 2, reservation: 0.5 }],
      }),
    ).toContain("USD 2 with 0.5 reserved before each supported billed operation")
    expect(text).toContain("call get_goal")
    expect(text).toContain('update_goal(status="complete")')
    expect(text).toContain("real successful tool calls")
    expect(text).toContain('update_goal(status="blocked")')
    expect(text).toContain("Independent authorized tasks may be in progress together")
    expect(text).toContain("keep dependent tasks pending")
    expect(text).toContain("continue independent authorized work while waiting")
    expect(text).not.toContain("exactly one item in progress")
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

  it("arms explicit goal-start commands without rewriting their objectives", () => {
    for (const prompt of [
      "Please start a durable goal to verify restart persistence.",
      "Arm the persistent goal for the migration and its readback.",
      "Create a durable goal: finish the checkout migration.",
    ]) {
      expect(hasGoalIntent(prompt)).toBe(true)
      expect(parseGoalCommand(prompt)).toEqual({
        kind: "start",
        objective: prompt,
        notice: "Raya recognized this as durable goal work and will continue until it is verified or honestly blocked.",
      })
    }
  })

  it("saves the exact JSON-quoted objective while leaving the original request intact", () => {
    const objective = String.raw`Write C:\Users\kamil\AppData\Local\Temp\raya-general-model\workspace\write-readback.txt with exactly general_nonce followed by one LF newline and verify the entire file using Read.`
    const prompt = `Create a persistent goal with objective exactly ${JSON.stringify(objective)}, then delegate the work to exactly one local General worker with edit access.`
    expect(hasGoalIntent(prompt)).toBe(true)
    expect(parseGoalCommand(prompt)).toMatchObject({ kind: "start", objective })
    expect(prompt).toContain(", then delegate the work to exactly one local General worker with edit access.")
  })

  it("preserves literal goal-command tokens inside an exact objective", () => {
    const objective = String.raw`Write C:\Raya\workspace\notes.txt with exactly /goal notes and verify the full file.`
    expect(
      parseGoalCommand(`Create a persistent goal with objective exactly ${JSON.stringify(objective)}.`),
    ).toMatchObject({
      kind: "start",
      objective,
    })
  })

  it("refuses malformed exact objectives instead of arming the command as the objective", () => {
    for (const prompt of [
      "Create a persistent goal with objective exactly",
      "Create a persistent goal with objective exactly write the file.",
      'Create a persistent goal with objective exactly "unfinished',
      String.raw`Create a persistent goal with objective exactly "Write C:\Raya\result.txt".`,
      'Create a persistent goal with objective exactly "".',
      'Create a persistent goal with objective exactly "read" trailing unseparated instructions',
    ]) {
      expect(parseGoalCommand(prompt)).toEqual({
        kind: "usage",
        notice: 'Use a JSON-quoted objective after "with objective exactly", or use /goal <objective>.',
      })
    }
  })

  it("does not arm goal questions, examples, discussion, or controls", () => {
    for (const prompt of [
      "Should I create a persistent goal for this migration?",
      "Can you explain how to start a durable goal?",
      "Create a persistent goal?",
      '"Create a persistent goal with objective exactly migration" is an example.',
      "Example: Create a durable goal to verify restart persistence.",
      "Discuss whether we should create a persistent goal for the migration.",
      "Do not create a persistent goal for this bounded edit.",
      "Pause the persistent goal for the migration.",
      "Clear the persistent goal for the migration.",
      "Create a persistent goalkeeper profile for the test.",
    ]) {
      expect(hasGoalIntent(prompt)).toBe(false)
      expect(parseGoalCommand(prompt)).toBeUndefined()
    }
  })
  // raya_change end
})
