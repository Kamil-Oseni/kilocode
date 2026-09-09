import { expect, test } from "bun:test"
import type { StepFinishPart } from "@kilocode/sdk/v2"
import { createSessionData, reduceSessionData } from "@/cli/cmd/run/session-data"

test("direct-run costs replace duplicate receipts and preserve unknown versus zero", () => {
  const data = createSessionData()
  const part: StepFinishPart = {
    id: "prt_cost",
    sessionID: "ses_cost",
    messageID: "msg_cost",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    accounting: {
      version: 1,
      status: "reported",
      source: "provider",
      currency: "USD",
      amount: 0,
      buckets: [],
      issues: [],
    },
  }
  const reduce = (part: StepFinishPart) =>
    reduceSessionData({
      data,
      sessionID: "ses_cost",
      thinking: false,
      limits: {},
      event: {
        id: `evt_${part.id}`,
        type: "message.part.updated",
        properties: { sessionID: part.sessionID, part, time: 1 },
      },
    }).footer?.patch?.usage
  expect(reduce(part)).toBe("Observed model steps: $0.00")
  const paid = { ...part, cost: 1, accounting: { ...part.accounting!, amount: 1 } }
  expect(reduce(paid)).toBe("Observed model steps: $1.00")
  expect(reduce(paid)).toBe("Observed model steps: $1.00")
  expect(data.costs.size).toBe(1)
  expect(reduce({ ...paid, sessionID: "ses_other", id: "prt_other" })).toBeUndefined()
  expect(data.costs.size).toBe(1)
  expect(
    reduce({
      ...part,
      id: "prt_unknown",
      accounting: {
        version: 1,
        status: "unknown",
        source: "missing",
        buckets: [],
        issues: ["input_usage_missing"],
      },
    }),
  ).toBe("Observed model steps: $1.00 partial")
})
