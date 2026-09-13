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
  expect(text).toContain(
    "No active-time, recorded model-cost, non-model charge, recovery-attempt, or concurrent-child limit was saved.",
  )
  expect(text).toContain("No deliverable inventory was retained for this goal version.")
  const saved = report(
    {
      objective: "Verified",
      usage: {
        turns: 3,
        toolCalls: 7,
        continuations: 2,
        cost: 1.25,
        descendantCost: 0.4,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        descendantTokens: { input: 2, output: 5, reasoning: 1, cache: { read: 1, write: 2 } },
      },
      activeMs: 12500,
      budget: {
        activeMs: 60_000,
        modelCost: 2,
        recoveryAttempts: 3,
        concurrentChildren: 2,
        chargeCosts: [{ currency: "USD", limit: 4, reservation: 0.5 }],
      },
      budgetHit: { kind: "recovery-attempts", limit: 3, observed: 3, at: 1 },
      charges: [
        {
          id: "tool-charge",
          kind: "tool",
          provider: "Example",
          service: "Research",
          origin: { sessionID: "parent", callID: "call" },
          at: 1,
          coverage: "recorded",
          amount: 0.25,
          currency: "USD",
          source: "usage.cost",
        },
        {
          id: "live-duration",
          kind: "gpt-live",
          provider: "OpenAI",
          service: "GPT-Live 1",
          origin: { sessionID: "parent", callID: "voice" },
          at: 1,
          quantity: 4.5,
          unit: "seconds",
          coverage: "unknown",
          reason: "The provider duration was retained, but a monetary amount was not reported.",
        },
      ],
      deliverables: [
        {
          path: "/workspace/output.md",
          revision: {
            version: 1,
            status: "captured",
            path: "/workspace/output.md",
            canonical: "/workspace/output.md",
            sha256: "a".repeat(64),
            mode: 420,
          },
          tool: "write",
          evidence: {
            callID: "call",
            sessionID: "child",
            messageID: "message",
            partID: "part",
            summary: "Created the report",
            record: { version: 1, digest: "digest", at: 1 },
          },
        },
        {
          kind: "canvas",
          path: ".raya/canvases/sales-report.canvas.tsx",
          version: 3,
          tool: "update_canvas",
          evidence: {
            callID: "canvas-call",
            sessionID: "child",
            messageID: "canvas-message",
            partID: "canvas-part",
            summary: "Updated the live report",
          },
        },
        {
          kind: "browser-download",
          path: "C:\\browser-artifacts\\transfer-report\\artifact",
          transferID: "transfer-report",
          filename: "monthly-report.csv",
          url: "https://example.com/monthly-report.csv",
          bytes: 2048,
          sha256: "b".repeat(64),
          tool: "browser_download",
          evidence: {
            callID: "download-call",
            sessionID: "child",
            messageID: "download-message",
            partID: "download-part",
            summary: "Inspected the completed browser download",
          },
        },
      ],
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
  expect(saved).toContain("Recorded goal-tree model cost: $1.250000")
  expect(saved).toContain("Direct goal-session model cost: $0.850000.")
  expect(saved).toContain("Delegated-session model cost: $0.400000")
  expect(saved).toContain("Active-time limit: 60.0 seconds.")
  expect(saved).toContain("Goal-session recorded model-cost limit: $2.000000.")
  expect(saved).toContain("Consecutive automatic recovery-attempt limit: 3.")
  expect(saved).toContain("Concurrent delegated-child limit: 2.")
  expect(saved).toContain("USD non-model charge limit: 4.000000; reserve 0.500000")
  expect(saved).toContain("A child slot is reserved before child-session creation")
  expect(saved).toContain("Reducing the limit does not cancel running children")
  expect(saved).toContain("Limit reached: automatic recovery attempts; limit 3; observed 3")
  expect(saved).toContain("Recovery attempts are consecutive and renew after successful work or a revised approach")
  expect(saved).toContain("does not recall a turn already running")
  expect(saved).toContain("Recorded USD: 0.250000.")
  expect(saved).toContain("Billing source: usage.cost.")
  expect(saved).toContain("GPT-Live 1: monetary cost unknown. Quantity: 4.5 seconds.")
  expect(saved).toContain("Unknown amounts and non-model charges are not added to the recorded model-cost limit")
  expect(saved).toContain("## Deliverables")
  expect(saved).toContain("> /workspace/output.md")
  expect(saved).toContain(`Captured SHA-256: ${"a".repeat(64)}`)
  expect(saved).toContain("Source tool: write")
  expect(saved).toContain("### Canvas")
  expect(saved).toContain("> .raya/canvases/sales-report.canvas.tsx")
  expect(saved).toContain("Recorded version: 3")
  expect(saved).toContain("Source tool: update_canvas")
  expect(saved).toContain("> Call: canvas-call")
  expect(saved).toContain("> Updated the live report")
  expect(saved).toContain("### Browser download")
  expect(saved).toContain("> monthly-report.csv")
  expect(saved).toContain("Artifact path: C:\\browser-artifacts\\transfer-report\\artifact")
  expect(saved).toContain("Source URL: https://example.com/monthly-report.csv")
  expect(saved).toContain("Transfer: transfer-report")
  expect(saved).toContain("Bytes: 2048")
  expect(saved).toContain(`SHA-256: ${"b".repeat(64)}`)
  expect(saved).toContain("Source tool: browser_download")
  expect(saved).toContain("> Call: download-call")
  expect(saved).toContain("> Inspected the completed browser download")
  expect(saved).toContain(
    "Coverage: revision-safe file mutations, ready Canvas versions and host-verified completed browser downloads cited by the accepted completion audit",
  )
  expect(saved).toContain("Tokens: input 10; output 20; reasoning 3; cache read 4; cache write 5.")
  expect(saved).toContain(
    "Delegated-session tokens included above: input 2; output 5; reasoning 1; cache read 1; cache write 2.",
  )
  expect(saved).toContain(
    "Parent message cost already contains descendant cost recursively, so delegated cost is attributed without adding it twice",
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
