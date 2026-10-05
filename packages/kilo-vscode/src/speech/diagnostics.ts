type Phase = "start" | "health" | "job" | "chunk" | "cleanup" | "error" | "callback" | "idle" | "handoff"
const boundaries = ["marker", "bind", "message", "text", "wait", "refused", "consume", "cancel", "skip"] as const
const reasons = [
  "duplicate",
  "unbound",
  "foreign",
  "stale",
  "nonterminal",
  "missing-text",
  "unended",
  "spoken",
  "cancelled",
  "replaced",
  "off",
  "cloud-engine",
  "live-active",
] as const
type Fields = {
  boundary?: (typeof boundaries)[number]
  reason?: (typeof reasons)[number]
  ended?: boolean
  failed?: boolean
  parts?: number
  job?: string
  status?: "queued" | "running" | "completed" | "failed" | "cancelled"
  http?: number
  index?: number
  chunks?: number
  bytes?: number
  rate?: number
  peak?: number
  nonzero?: number
  forwarded?: boolean
  confirmed?: boolean
  kind?: "voice" | "chunk" | "done" | "error"
  mime?: "audio/wav" | "audio/pcm"
}

export type PlaybackDiagnostic = Fields & { request: string; phase: Phase; elapsed: number }

/** Finite, content-free observations; never include text, audio, endpoints or credentials. */
export function diagnostics(
  request: string,
  write = (row: PlaybackDiagnostic) => console.info("[Raya Voice]", JSON.stringify(row)),
) {
  const start = Date.now()
  let count = 0
  return (phase: Phase, fields: Fields = {}) => {
    if (!["start", "health", "job", "chunk", "cleanup", "error", "callback", "idle", "handoff"].includes(phase)) return
    if (count++ >= 128) return
    const row: PlaybackDiagnostic = {
      request: /^(?:req_)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request)
        ? request
        : "unavailable",
      phase,
      elapsed: Math.max(0, Math.min(180_000, Date.now() - start)),
    }
    if (fields.job && /^[0-9a-f]{32}$/.test(fields.job)) row.job = fields.job
    if (fields.status && ["queued", "running", "completed", "failed", "cancelled"].includes(fields.status))
      row.status = fields.status
    if (fields.kind && ["voice", "chunk", "done", "error"].includes(fields.kind)) row.kind = fields.kind
    if (fields.mime === "audio/wav" || fields.mime === "audio/pcm") row.mime = fields.mime
    if (fields.boundary && boundaries.includes(fields.boundary)) row.boundary = fields.boundary
    if (fields.reason && reasons.includes(fields.reason)) row.reason = fields.reason
    numbers(row, fields)
    for (const key of ["forwarded", "confirmed", "ended", "failed"] as const) {
      if (typeof fields[key] === "boolean") row[key] = fields[key]
    }
    try {
      write(row)
    } catch {
      console.warn("[Raya Voice] Diagnostic observer failed.")
    }
  }
}

function numbers(row: PlaybackDiagnostic, fields: Fields) {
  for (const key of ["http", "index", "chunks", "bytes", "rate", "peak", "nonzero", "parts"] as const) {
    const value = fields[key]
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 67_108_864) row[key] = value
  }
}
