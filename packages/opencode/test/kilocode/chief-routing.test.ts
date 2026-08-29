// raya_change - Milestone B intelligent auto-routing
import { describe, expect, it } from "bun:test"
import { RayaChief } from "../../src/kilocode/chief"
import data from "./fixtures/chief-routing.json"

type Fixture = {
  prompt: string
  agent: RayaChief.Role
}

const fixtures = data as Fixture[]
const agents: RayaChief.Agent[] = [
  { name: "generalist", description: "Fast generalist for small direct tasks" },
  { name: "coder", description: "Software implementation, fixes, refactors, APIs, and tests" },
  { name: "designer", description: "UI, UX, Figma, layouts, visual systems, and motion" },
  { name: "researcher", description: "Research, sources, documentation, evidence, and benchmarks" },
  { name: "accountant", description: "Ledgers, reconciliation, invoices, statements, tax, and finance" },
  { name: "reasoner", description: "Architecture, algorithms, proofs, security, concurrency, and trade-offs" },
]

describe("Raya Chief routing", () => {
  it(`meets the ${(RayaChief.target * 100).toFixed(0)}% labeled-fixture accuracy target`, () => {
    const decisions = fixtures.map((item) => ({
      expected: item.agent,
      actual: RayaChief.route({ request: item.prompt, agents }).role,
    }))
    const correct = decisions.filter((item) => item.actual === item.expected).length
    const accuracy = correct / decisions.length

    expect(fixtures.length).toBeGreaterThanOrEqual(25)
    expect(new Set(fixtures.map((item) => item.agent))).toEqual(
      new Set(["coder", "designer", "researcher", "accountant", "reasoner"]),
    )
    expect(accuracy).toBeGreaterThanOrEqual(RayaChief.target)
  })

  it("adds negligible local policy latency before the measured cheap-model call", () => {
    const started = performance.now()
    for (let index = 0; index < 1_000; index++) {
      const item = fixtures[index % fixtures.length]!
      RayaChief.route({ request: item.prompt, agents })
    }
    const elapsed = performance.now() - started

    expect(elapsed / 1_000).toBeLessThan(0.25)
  })

  it("marks ambiguous requests for an in-chat option prompt instead of guessing", () => {
    const request = "Help me decide what to do with this project"
    const decision = RayaChief.route({ request, agents })

    expect(decision.confidence).toBeLessThan(RayaChief.threshold)
    expect(RayaChief.needsPrompt(decision, RayaChief.threshold, request)).toBe(true)
    expect(decision.candidates.length).toBeGreaterThanOrEqual(2)
    expect(RayaChief.question(decision)).toMatchObject({
      prompt: "Auto found more than one plausible specialist. Who should handle this request?",
      allow_multiple: false,
      options: decision.candidates.map((item) => ({
        id: item.agent,
        label: item.agent,
      })),
    })
  })

  // raya_change - ordinary and spoken conversational turns should not trigger a specialist questionnaire
  it("routes small direct requests to the fast generalist without prompting", () => {
    const request = "Write a one-sentence greeting"
    const decision = RayaChief.route({ request, agents })

    expect(decision.agent).toBe("generalist")
    expect(RayaChief.needsPrompt(decision, RayaChief.threshold, request)).toBe(false)
  })

  // raya_change - regression for a trivial file task previously sent to Designer
  it("keeps one small temporary file task away from Designer", () => {
    const decision = RayaChief.route({
      request: "Create one temporary test file, explain what you did, then stop.",
      agents,
    })

    expect(decision).toMatchObject({
      agent: "generalist",
      role: "generalist",
      needs_plan: false,
    })
    expect(decision.confidence).toBeGreaterThanOrEqual(RayaChief.threshold)
  })

  // raya_change - synthetic persistent-goal policy must not pollute the user's routing intent
  it("classifies only user-authored text when a goal adds synthetic guidance", () => {
    const objective = "Create one text file"
    const request = RayaChief.requestText([
      { type: "text", text: objective },
      {
        type: "text",
        text: "Gather evidence, audit every requirement, inspect the design and research alternatives.",
        synthetic: true,
      },
    ])

    expect(request).toBe(objective)
    expect(RayaChief.route({ request, agents }).agent).toBe("generalist")
    expect(
      RayaChief.requestText(
        [{ type: "text", text: "Synthetic continuation policy", synthetic: true }],
        "Create one text file, then append Hello World",
      ),
    ).toBe("Create one text file, then append Hello World")
  })

  // raya_change - Milestone I configurable routing threshold
  it("applies the configured confidence threshold without code changes", () => {
    const decision = { confidence: 0.8 } as Pick<ReturnType<typeof RayaChief.route>, "confidence">
    expect(RayaChief.needsPrompt(decision, 0.85)).toBe(true)
    expect(RayaChief.needsPrompt(decision, 0.75)).toBe(false)
  })

  // raya_change start - Auto phase enforcement regression
  it("keeps the bounded Auto workflow dispatchable across same-response tool calls", () => {
    const tools = {
      chief_route: { id: "chief" },
      task: { id: "task" },
      get_goal: { id: "get" },
      update_goal: { id: "update" },
      read: { id: "read" },
    }

    const workflow = ["chief_route", "task", "get_goal", "update_goal"]
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "route" }))).toEqual(workflow)
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "task" }))).toEqual(workflow)
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "goal" }))).toEqual(workflow)
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "done" }))).toEqual(workflow)
    expect(RayaChief.repair({ agent: "auto", tools: { chief_route: tools.chief_route } })).toEqual({
      toolName: "chief_route",
      input: { objective: "Route the current user's exact request." },
    })
    expect(RayaChief.repair({ agent: "auto", tools: { task: tools.task } })).toMatchObject({
      toolName: "task",
    })
    expect(RayaChief.repair({ agent: "code", tools: { chief_route: tools.chief_route } })).toBeUndefined()
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "goal" })).toBe("route")
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "goal" }, true)).toBe("task")
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "route" }, true)).toBe("task")
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "done" }, true)).toBe("task")
    expect(
      RayaChief.follow({
        [RayaChief.logKey]: [
          {
            request: "Create three temporary text files",
            agent: "generalist",
            model: "test/model",
            needs_plan: false,
            confidence: 0.94,
            reason: "small direct task",
            latency: 1,
            chiefModel: "test/model",
            candidates: [{ agent: "generalist", role: "generalist", score: 1, reason: "small" }],
            prompted: false,
          },
        ],
      })?.agent,
    ).toBe("generalist")
    expect(RayaChief.lastStep).toContain("update_goal")
  })
  // raya_change end
})
