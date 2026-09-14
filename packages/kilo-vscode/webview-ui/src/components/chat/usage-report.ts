import type { ProjectUsage } from "../../types/messages"

export function report(usage: ProjectUsage & { projectID?: string }) {
  const amounts = (value: ProjectUsage["totals"]) => ({
    steps: value.steps,
    tokens: value.tokens,
    evidencedUSD: value.accounting?.amount ?? null,
    coverage: value.accounting ?? null,
    legacyCompatibilityCost: value.cost,
  })
  const charges = usage.charges
    ? {
        items: usage.charges.items,
        coverage: {
          goals: usage.charges.goals,
          unreadable: usage.charges.unreadable,
          conflicts: usage.charges.conflicts,
        },
      }
    : { items: null, coverage: "unavailable" }
  return JSON.stringify(
    {
      format: "raya-model-usage-summary",
      version: 2,
      projectID: usage.projectID ?? null,
      scope: "Settled model steps and retained goal-charge receipts in this backend project.",
      limitations: [
        "Summary only; individual step receipts, source rate cards and prompts are not included.",
        "Reported amounts are not invoice-final. Estimates and incomplete coverage remain identified.",
        "Model cost and non-model currencies remain separate. Unknown charge amounts are never treated as zero.",
        "Conflicting or unreadable goal ledgers are excluded and counted in non-model coverage.",
        "Legacy compatibility cost is not evidenced USD.",
        ...(usage.projectID ? [] : ["This backend response does not identify the project."]),
      ],
      window: { range: usage.range, since: usage.since ?? null, until: usage.until, timezone: usage.timezone },
      sessions: usage.sessions,
      totals: amounts(usage.totals),
      nonModelCharges: charges,
      models: usage.models.map((model) => ({
        providerID: model.providerID,
        modelID: model.modelID,
        ...amounts(model),
      })),
    },
    null,
    2,
  )
}
