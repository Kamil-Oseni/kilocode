const guidance = {
  schedule: "Review the schedule and timezone, then preview again. Your draft is still available.",
  capability: "Review the requested capabilities before submitting again. Your draft is still available.",
  output:
    "Review the output requirements and verification criteria before submitting again. Your draft is still available.",
  conflict: "Reload the current routine and compare it with your draft before submitting again.",
  paused: "Review why this routine is paused before resuming it.",
  access: "Review this routine's workspace access before starting it.",
  unavailable: "Reconnect, then check the routine's current state before trying again.",
  connection:
    "Check the connection, then inspect the routine's current state before trying again. The request may have reached the backend.",
} as const

export type RoutineRecovery = { kind: keyof typeof guidance; field?: string; next: string }

export function recovery(error: unknown): RoutineRecovery | undefined {
  if (!error || typeof error !== "object") return
  const kind: unknown = Reflect.get(error, "kind")
  if (typeof kind === "string" && Object.hasOwn(guidance, kind)) {
    const field: unknown = Reflect.get(error, "field")
    return {
      kind: kind as keyof typeof guidance,
      field: typeof field === "string" ? field : undefined,
      next:
        kind === "unavailable" && field === "worker-roster"
          ? "Restore the worker list from a backup before creating or running workers."
          : guidance[kind as keyof typeof guidance],
    }
  }
  const code: unknown = Reflect.get(error, "code")
  if (typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code))
    return { kind: "connection", next: guidance.connection }
  for (const key of ["data", "error", "cause"]) {
    const nested: unknown = Reflect.get(error, key)
    if (!nested || typeof nested !== "object" || nested === error) continue
    // The SDK wraps decoded HTTP failures in Error.cause.body.
    const body: unknown = Reflect.get(nested, "body")
    const value = body && typeof body === "object" ? body : nested
    const kind: unknown = Reflect.get(value, "kind")
    const code: unknown = Reflect.get(value, "code")
    if ((typeof kind === "string" && Object.hasOwn(guidance, kind)) || typeof code === "string") {
      const result = recovery({ kind, code, field: Reflect.get(value, "field") })
      if (result) return result
    }
  }
}
