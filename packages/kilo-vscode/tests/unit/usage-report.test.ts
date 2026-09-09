import { expect, test } from "bun:test"
import { report } from "../../webview-ui/src/components/chat/usage-report"
import type { ProjectUsage } from "../../webview-ui/src/types/messages"

const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } }
const totals = {
  steps: 3,
  cost: 100,
  tokens,
  accounting: { amount: 0.00000001, reported: 1, estimated: 1, partial: 0, unknown: 0, legacy: 1 },
}
const usage: ProjectUsage & { projectID?: string } = {
  projectID: "project-a",
  range: "7d",
  since: 1000,
  until: 2000,
  timezone: "UTC",
  sessions: 2,
  totals,
  models: [{ providerID: 'private"provider', modelID: "model\nname", ...totals }],
}

test("usage report preserves exact scope and precision without relabeling legacy amounts", () => {
  const value = JSON.parse(report(usage))
  expect(value.projectID).toBe("project-a")
  expect(value.window).toEqual({ range: "7d", since: 1000, until: 2000, timezone: "UTC" })
  expect(value.totals.evidencedUSD).toBe(0.00000001)
  expect(value.totals.legacyCompatibilityCost).toBe(100)
  expect(value.totals.coverage).toEqual(totals.accounting)
  expect(value.models[0].providerID).toBe('private"provider')
  expect(value.models[0].modelID).toBe("model\nname")
  expect(value.limitations.join(" ")).toContain("not invoice-final")
  expect(value.limitations.join(" ")).toContain("individual step receipts")
})

test("legacy response keeps missing project and accounting evidence explicitly unknown", () => {
  const value = JSON.parse(
    report({ ...usage, projectID: undefined, since: undefined, totals: { steps: 1, cost: 0, tokens } }),
  )
  expect(value.projectID).toBeNull()
  expect(value.window.since).toBeNull()
  expect(value.totals.evidencedUSD).toBeNull()
  expect(value.totals.coverage).toBeNull()
  expect(value.limitations.join(" ")).toContain("does not identify the project")
})

test("reported zero remains zero with its coverage", () => {
  const value = JSON.parse(
    report({
      ...usage,
      totals: { ...totals, accounting: { ...totals.accounting, amount: 0, estimated: 0, legacy: 0 } },
    }),
  )
  expect(value.totals.evidencedUSD).toBe(0)
  expect(value.totals.coverage.reported).toBe(1)
  expect(value.totals.coverage.estimated).toBe(0)
})
