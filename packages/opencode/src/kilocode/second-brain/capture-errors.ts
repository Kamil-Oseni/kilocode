import type { CaptureFailure } from "./capture-protocol"
import { Cause } from "effect"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"

export function diagnosis(cause: Cause.Cause<unknown>) {
  const err = Cause.squash(cause)
  const errors = err instanceof AggregateError ? err.errors : [err]
  return [
    ...new Set(
      errors
        .slice(0, 4)
        .map((item) => MemoryRedact.text(item instanceof Error ? item.message : String(item)).slice(0, 95)),
    ),
  ]
    .slice(0, 2)
    .join("; ")
}

/** Only bounded classifications leave extraction; neither model text nor keys enter diagnostics. */
export class CaptureRejected extends Error {
  constructor(readonly reason: typeof CaptureFailure.Type) {
    super(
      reason === "invalid_schema"
        ? "Capture extraction does not match the bounded entry schema (invalid_schema)"
        : ["duplicate_key", "secret_text", "restricted_key"].includes(reason)
          ? `Capture extraction contains duplicate or restricted entries (${reason})`
          : `Capture extraction failed before publication (${reason})`,
    )
  }
}
