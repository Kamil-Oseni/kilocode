import { describe, expect, it } from "bun:test"
import { evaluate } from "../../script/computer-use-eval"

describe("Computer Use evaluation contract", () => {
  it("measures effects, refusals, recovery, latency, cost, and human intervention", async () => {
    const report = await evaluate()
    expect(report).toMatchObject({
      format: "raya.computer-use-evaluation",
      version: 1,
      mode: "deterministic",
      summary: {
        successRate: 1,
        unintendedDispatches: 0,
        staleFrameRefusals: 2,
        recoverySuccesses: 1,
        humanInterventions: 1,
        modelCostUsd: 0,
      },
    })
    expect(report.scenarios.map((item) => item.id)).toEqual([
      "grounded-effect",
      "changed-target-refusal",
      "observation-replay-refusal",
      "takeover-and-recovery",
    ])
    expect(report.scenarios.every((item) => item.passed && item.actualDispatches === item.expectedDispatches)).toBe(
      true,
    )
    expect(Number.isFinite(report.summary.latencyP95Ms)).toBe(true)
  })
})
