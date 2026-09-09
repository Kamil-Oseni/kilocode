const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Describe recorded presentation only; neither content correctness nor current freshness is established here. */
export const inspection = (metadata: Record<string, unknown>) => {
  const display = metadata["display"]
  if (!object(display)) return { kind: "unknown" as const, coverage: "unknown" as const }
  if (display["type"] === "directory") return { kind: "directory" as const, coverage: "listing" as const }
  if (display["type"] !== "file") return { kind: "unknown" as const, coverage: "unknown" as const }
  const start = display["lineStart"]
  const end = display["lineEnd"]
  const count = display["totalLines"]
  if (
    !integer(start) ||
    start < 1 ||
    !integer(end) ||
    !integer(count) ||
    (end < start && !(start === 1 && end === 0 && count === 0)) ||
    end > count ||
    typeof display["truncated"] !== "boolean" ||
    typeof metadata["truncated"] !== "boolean"
  )
    return { kind: "text" as const, coverage: "unknown" as const }
  const partial = start > 1 || end < count || display["truncated"] || metadata["truncated"]
  return {
    kind: "text" as const,
    coverage: partial ? ("partial" as const) : ("displayed" as const),
    lineStart: start,
    lineEnd: end,
    reportedLines: count,
    // A file digest covers bytes, while these fields describe only the text presentation.
    fullReview: "not-established" as const,
  }
}
