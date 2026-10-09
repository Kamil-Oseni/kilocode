const stages = ["authorization", "publication", "admission", "closure", "index", "confirmation"] as const
type Stage = (typeof stages)[number]
const codes = [
  "capture_source_capacity",
  "control_uncertain",
  "control_busy",
  "unsupported",
  "identity_mismatch",
  "transport_error",
  "service_error",
  "invalid_response",
  "retirement_unconfirmed",
  "admission_closed",
] as const
const messages = new Map([
  ["Original Memory setup or debt changed before settlement", "settlement_changed"],
  ["Original Memory operation is not terminal", "operation_pending"],
  ["Original managed generation is unavailable", "generation_unavailable"],
  ["Original capture configuration, workspace or generation changed", "capture_changed"],
  ["Original capture admission journal required", "admission_journal_missing"],
  ["Memory control closure is incomplete", "control_closure_incomplete"],
  ["Original capture and reindex were not confirmed", "index_unconfirmed"],
  ["Original indexed capture receipt differs", "receipt_changed"],
])

/** Host-only stage context; no note, source, credential or raw exception text is persisted. */
export class CaptureFailure extends Error {
  readonly code: string
  constructor(
    readonly stage: Stage,
    cause: unknown,
  ) {
    super("Original automatic save failed during " + stage, { cause })
    this.code =
      cause instanceof Error && "code" in cause && cause.code === "capture_source_capacity"
        ? "capture_source_capacity"
        : "control_uncertain"
  }
}

export function failure(error: unknown) {
  const errors: string[] = []
  const seen = new Set<unknown>()
  function visit(err: unknown, depth: number) {
    if (depth > 4 || seen.has(err) || errors.length >= 8) return
    seen.add(err)
    if (err instanceof CaptureFailure) return visit(err.cause, depth + 1)
    if (err instanceof AggregateError) {
      for (const item of err.errors) visit(item, depth + 1)
      return
    }
    const code =
      err instanceof Error && "code" in err && codes.some((code) => code === err.code)
        ? String(err.code)
        : err instanceof Error
          ? (messages.get(err.message) ?? "unclassified")
          : "unclassified"
    errors.push(code)
  }
  visit(error, 0)
  return {
    stage: error instanceof CaptureFailure ? error.stage : ("confirmation" as const),
    errors: errors.length ? errors : ["unclassified"],
  }
}
