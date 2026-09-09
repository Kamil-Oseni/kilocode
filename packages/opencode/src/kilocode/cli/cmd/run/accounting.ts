import type { StepFinishPart } from "@kilocode/sdk/v2"
import { costLabel } from "@opencode-ai/core/kilocode/accounting-label"
import { summarize } from "@opencode-ai/core/kilocode/accounting-summary"

export function costs() {
  return new Map<string, Pick<StepFinishPart, "cost" | "accounting">>()
}

export function cost(parts: ReturnType<typeof costs>, fallback?: number) {
  if (!parts.size) return `Current message: ${costLabel({ cost: fallback ?? 0 }, "en-US", true)}`
  const rows = [...parts.values()]
  return `Observed model steps: ${costLabel(
    {
      cost: rows.reduce((sum, item) => sum + item.cost, 0),
      accounting: summarize(rows),
    },
    "en-US",
    true,
  )}`
}
