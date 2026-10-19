export interface MemorySourceRequest {
  type: "openMemorySource"
  sessionID: string
  messageID: string
  partID: string
  callID: string
  source: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Labels only. The host resolves the original result again before opening anything. */
export function memorySources(raw: string | undefined) {
  if (!raw || raw.length > 200_000) return []
  const value: unknown = JSON.parse(raw)
  if (!record(value) || value.action !== "context" || !record(value.context)) return []
  const rows = value.context.sources
  if (!Array.isArray(rows) || rows.length > 12) return []
  return rows.flatMap((row: unknown, source) => {
    if (
      !record(row) ||
      typeof row.relative !== "string" ||
      row.relative.length > 4096 ||
      typeof row.line !== "number" ||
      !Number.isSafeInteger(row.line) ||
      row.line < 1 ||
      typeof row.end_line !== "number" ||
      !Number.isSafeInteger(row.end_line) ||
      row.end_line < row.line
    )
      return []
    return [{ source, label: `${row.relative}:${row.line}–${row.end_line}` }]
  })
}
