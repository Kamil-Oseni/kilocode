import type { ProjectUsage } from "../../types/messages"

export function report(usage: ProjectUsage & { projectID?: string }) {
  const amounts = (value: ProjectUsage["totals"]) => ({
    steps: value.steps,
    tokens: value.tokens,
    evidencedUSD: value.accounting?.amount ?? null,
    coverage: value.accounting ?? null,
    legacyCompatibilityCost: value.cost,
  })
  return JSON.stringify(
    {
      format: "raya-model-usage-summary",
      version: 1,
      projectID: usage.projectID ?? null,
      scope: "Settled model steps in this backend project, counted once per step across conversations.",
      limitations: [
        "Summary only; individual step receipts, source rate cards and prompts are not included.",
        "Reported amounts are not invoice-final. Estimates and incomplete coverage remain identified.",
        "Separately billed tools and media are not included. Legacy compatibility cost is not evidenced USD.",
        ...(usage.projectID ? [] : ["This backend response does not identify the project."]),
      ],
      window: { range: usage.range, since: usage.since ?? null, until: usage.until, timezone: usage.timezone },
      sessions: usage.sessions,
      totals: amounts(usage.totals),
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
