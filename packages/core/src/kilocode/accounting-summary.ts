import type { Accounting } from "@opencode-ai/schema/kilocode/accounting"

export function empty() {
  return { amount: 0, reported: 0, estimated: 0, partial: 0, unknown: 0, legacy: 0 }
}

export function summarize(parts: Iterable<{ accounting?: Accounting }>) {
  const summary = empty()
  for (const part of parts) {
    const item = part.accounting
    if (!item) {
      summary.legacy++
      continue
    }
    if (
      item.status === "unknown" ||
      item.currency !== "USD" ||
      typeof item.amount !== "number" ||
      !Number.isFinite(item.amount) ||
      item.amount < 0 ||
      !Number.isFinite(summary.amount + item.amount)
    ) {
      summary.unknown++
      continue
    }
    summary[item.status]++
    summary.amount += item.amount
  }
  return summary
}

export function merge(target: ReturnType<typeof empty>, source: ReturnType<typeof empty>) {
  if (!Number.isFinite(target.amount + source.amount)) {
    target.unknown += source.reported + source.estimated + source.partial + source.unknown
    target.legacy += source.legacy
    return
  }
  target.amount += source.amount
  target.reported += source.reported
  target.estimated += source.estimated
  target.partial += source.partial
  target.unknown += source.unknown
  target.legacy += source.legacy
}
