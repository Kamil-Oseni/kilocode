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
    const decision = RayaChief.route({ request: "Help me decide what to do with this project", agents })

    expect(decision.confidence).toBeLessThan(RayaChief.threshold)
    expect(RayaChief.needsPrompt(decision)).toBe(true)
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

  // raya_change start - Auto phase enforcement regression
  it("exposes one legal action per Auto phase and repairs hallucinated tools to it", () => {
    const tools = { chief_route: { id: "chief" }, task: { id: "task" }, read: { id: "read" } }

    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "route" }))).toEqual(["chief_route"])
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "task" }))).toEqual(["task"])
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "synthesize" }))).toEqual([])
    expect(RayaChief.repair({ agent: "auto", tools: { chief_route: tools.chief_route } })).toEqual({
      toolName: "chief_route",
      input: { objective: "Route the current user's exact request." },
    })
    expect(RayaChief.repair({ agent: "auto", tools: { task: tools.task } })).toMatchObject({
      toolName: "task",
    })
    expect(RayaChief.repair({ agent: "code", tools: { chief_route: tools.chief_route } })).toBeUndefined()
  })
  // raya_change end
})
