import { expect, test } from "bun:test"
import { report } from "../../src/shared/goal-report"

test("goal reports preserve exact references and mark legacy records instead of inventing evidence", () => {
  const text = report({ objective: "Legacy\nobjective", status: "complete", createdAt: 0, updatedAt: 1 })
  expect(text).toContain("> Legacy\n> objective")
  expect(text).toContain("No structured acceptance criteria were retained.")
  expect(text).toContain("No completion audit was retained.")
  expect(text).toContain("Execution counters were not retained.")
  expect(text).toContain("Goal-session model cost was not retained.")
  expect(text).toContain("Goal-session token totals were not retained.")
  expect(text).toContain("No active-time or recorded model-cost limit was saved.")
  const saved = report(
    {
      objective: "Verified",
      usage: {
        turns: 3,
        toolCalls: 7,
        continuations: 2,
        cost: 1.25,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      },
      activeMs: 12500,
      budget: { activeMs: 60_000, modelCost: 2 },
      budgetHit: { kind: "model-cost", limit: 2, observed: 2.25, at: 1 },
      status: "complete",
      createdAt: 0,
      updatedAt: 1,
      audit: {
        summary: "Recorded result",
        verifiedAt: 1,
        requirements: [
          {
            requirement: "Result",
            passed: true,
            evidence: [
              {
                callID: "call",
                sessionID: "child",
                messageID: "message",
                partID: "part",
                summary: "Source",
                record: { version: 1, digest: "digest", at: 1 },
              },
            ],
          },
        ],
      },
    },
    "parent",
  )
  expect(saved).toContain("> Session: child\n> Message: message\n> Part: part\n> Call: call")
  expect(saved).toContain("Recorded result digest (v1): digest")
  expect(saved).toContain("Evidence references accepted at submission.")
  expect(saved).toContain("does not rerun checks")
  expect(saved).toContain("Turns: 3\nTool calls: 7\nContinuations: 2")
  expect(saved).toContain("Accumulated active time: 12.5 seconds")
  expect(saved).toContain("Goal-session model cost: $1.250000")
  expect(saved).toContain("Active-time limit: 60.0 seconds.")
  expect(saved).toContain("Goal-session recorded model-cost limit: $2.000000.")
  expect(saved).toContain("Limit reached: recorded model cost; limit 2; observed 2.25")
  expect(saved).toContain("does not recall a turn already running")
  expect(saved).toContain("Tokens: input 10; output 20; reasoning 3; cache read 4; cache write 5.")
  expect(saved).toContain(
    "Child-session spend, tool fees, GPT-Live usage and external service charges are not included",
  )
})

test("copied reports retain current and historical command bindings without upgrading prose-only criteria", () => {
  const criteria = [
    {
      id: "check",
      description: "Deliver report",
      verification: "Inspect the result",
      check: {
        kind: "command" as const,
        command: "bun run check\n# literal second line",
        directory: "/workspace/report",
      },
    },
  ]
  const text = report({
    objective: "Current",
    status: "complete",
    createdAt: 0,
    updatedAt: 1,
    criteria,
    revisions: [
      { id: "prior", at: 1, source: "control", objective: "Earlier", criteria, budget: { activeMs: 30_000 } },
    ],
  })
  expect(text).toContain(
    "Required command:\n> bun run check\n> # literal second line\nWorking directory:\n> /workspace/report",
  )
  expect(text).toContain("> Required command:\n> > bun run check\n> > # literal second line")
  expect(text).toContain("User review: no separate acceptance was recorded.")
  expect(text).toContain("prose-only verification has no such binding")
  expect(text).toContain("> Active-time limit: 30.0 seconds.")
})
