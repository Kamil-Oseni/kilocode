function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function label(value: unknown, limit: number) {
  if (typeof value !== "string" || !value.trim()) return
  const text = value.trim()
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function location(value: unknown) {
  if (!record(value)) return
  if (typeof value.directory !== "string" || !value.directory.trim() || value.directory.length > 4096) return
  if (typeof value.project !== "string" || !value.project.trim() || value.project.length > 4096) return
  return { directory: label(value.directory, 400), project: label(value.project, 400) }
}

/** Decode display-only receipt metadata. Never expose recalled content or turn paths into actions. */
export function provenance(part: {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: unknown
}) {
  if (
    part.type !== "text" ||
    part.text !== "" ||
    part.synthetic !== true ||
    part.ignored !== true ||
    !record(part.metadata)
  )
    return
  const value = part.metadata.kiloMemory
  if (!record(value) || (value.type !== "startup" && value.type !== "recall")) return
  if (value.count !== undefined && !count(value.count)) return
  if (value.tokens !== undefined && !count(value.tokens)) return
  const sources = Array.isArray(value.files) ? value.files : Array.isArray(value.sources) ? value.sources : []
  const files = [...new Set(sources.slice(0, 5).flatMap((item) => label(item, 160) ?? []))]
  const captured = count(value.captured) && value.captured <= 8_640_000_000_000_000 ? value.captured : undefined
  const scope = location(value.scope)
  return {
    type: value.type,
    count: value.count,
    tokens: value.tokens,
    files,
    truncated: sources.length > 5,
    captured,
    directory: scope?.directory,
    project: scope?.project,
  }
}
