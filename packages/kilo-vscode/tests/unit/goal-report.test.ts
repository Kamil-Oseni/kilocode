import { expect, test } from "bun:test"
import { report } from "../../src/shared/goal-report"

test("goal reports preserve exact references and mark legacy records instead of inventing evidence", () => {
  const text = report({ objective: "Legacy\nobjective", status: "complete", createdAt: 0, updatedAt: 1 })
  expect(text).toContain("> Legacy\n> objective")
  expect(text).toContain("No structured acceptance criteria were retained.")
  expect(text).toContain("No completion audit was retained.")
  expect(text).toContain("Execution counters were not retained.")
  const saved = report(
    {
      objective: "Verified",
      usage: { turns: 3, toolCalls: 7, continuations: 2 },
      activeMs: 12500,
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
    revisions: [{ id: "prior", at: 1, source: "control", objective: "Earlier", criteria }],
  })
  expect(text).toContain(
    "Required command:\n> bun run check\n> # literal second line\nWorking directory:\n> /workspace/report",
  )
  expect(text).toContain("> Required command:\n> > bun run check\n> > # literal second line")
  expect(text).toContain("User review: no separate acceptance was recorded.")
  expect(text).toContain("prose-only verification has no such binding")
})
