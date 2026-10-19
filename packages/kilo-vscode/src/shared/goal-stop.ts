export interface GoalStop {
  intent: string
  at: number
  phase: "requested" | "cleared" | "finished"
  interrupted?: boolean
  /** Validated original routine association; the backend retains retirement authority. */
  retirement?: true
}

export function pending(value: unknown): value is GoalStop {
  if (!value || typeof value !== "object") return false
  const stop = value as Record<string, unknown>
  return (
    typeof stop.intent === "string" &&
    stop.intent.trim().length > 0 &&
    stop.intent.length <= 256 &&
    typeof stop.at === "number" &&
    Number.isFinite(stop.at) &&
    stop.at >= 0 &&
    Number.isFinite(new Date(stop.at).getTime()) &&
    stop.phase === "cleared" &&
    typeof stop.interrupted === "boolean" &&
    stop.retirement === true
  )
}
