import type { SessionModelUsage } from "../types/messages"

export function costLabel(
  usage: Pick<SessionModelUsage["totals"], "cost" | "accounting">,
  locale: string,
  brief = false,
) {
  const money = (amount: number) =>
    amount > 0 && amount < 0.000001
      ? "< $0.000001"
      : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(amount)
  const summary = usage.accounting
  if (brief) return compact(usage, money)
  if (!summary) return usage.cost > 0 ? `${money(usage.cost)} · provenance unavailable` : "Cost unavailable"
  const known = summary.reported + summary.estimated + summary.partial
  if (!known)
    return summary.legacy && usage.cost > 0
      ? `${money(usage.cost)} · legacy cost, provenance unavailable`
      : "Cost unavailable"
  const approximate = summary.estimated + summary.partial > 0
  const incomplete = summary.unknown + summary.partial + summary.legacy > 0
  const amount = `${approximate ? "≈ " : ""}${money(summary.amount)}`
  if (incomplete) return `${amount} known · incomplete cost`
  if (summary.reported && approximate) return `${amount} · reported + estimated`
  return `${amount} · ${approximate ? "estimated from usage" : "reported by provider"}`
}

function compact(usage: Pick<SessionModelUsage["totals"], "cost" | "accounting">, money: (amount: number) => string) {
  const summary = usage.accounting
  if (!summary || (!summary.reported && !summary.estimated && !summary.partial))
    return usage.cost > 0 && (!summary || summary.legacy > 0) ? `${money(usage.cost)} unverified` : "Cost unknown"
  const amount = `${summary.estimated + summary.partial > 0 ? "\u2248 " : ""}${money(summary.amount)}`
  return summary.unknown + summary.partial + summary.legacy > 0 ? `${amount} partial` : amount
}
