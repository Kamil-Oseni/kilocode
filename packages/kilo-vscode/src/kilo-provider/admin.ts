import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { AdminHealth, AdminHostSignals, AdminResult, AdminRow } from "../shared/admin"

type Post = (message: AdminResult) => void

const browser = new Set(["ready", "locked", "auth_expired", "closed", "unavailable", "error"])

function failed(id: "browser" | "voice", at: number): AdminRow {
  return { id, status: "unknown", reason: "probe-failed", observedAt: at }
}

function browserRow(value: Awaited<ReturnType<NonNullable<AdminHostSignals["browser"]>>>, at: number): AdminRow {
  if (!browser.has(value.status)) return failed("browser", at)
  if (value.status === "ready") return { id: "browser", status: "healthy", reason: "ready", observedAt: at }
  if (value.status === "locked") return { id: "browser", status: "blocked", reason: "browser-locked", observedAt: at }
  if (value.status === "auth_expired")
    return { id: "browser", status: "blocked", reason: "browser-auth-expired", observedAt: at }
  if (value.status === "closed") return { id: "browser", status: "offline", reason: "browser-closed", observedAt: at }
  if (value.status === "unavailable")
    return { id: "browser", status: "offline", reason: "browser-unavailable", observedAt: at }
  return { id: "browser", status: "degraded", reason: "browser-error", observedAt: at }
}

function voiceRow(value: Awaited<ReturnType<NonNullable<AdminHostSignals["voice"]>>>, at: number): AdminRow {
  const counts = [value.active, value.failed, value.incomplete]
  if (
    typeof value.available !== "boolean" ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > 3)
  )
    return failed("voice", at)
  if (!value.available) return { id: "voice", status: "offline", reason: "voice-unavailable", observedAt: at }
  const metrics = { active: value.active, failed: value.failed, incomplete: value.incomplete }
  if (value.failed) return { id: "voice", status: "degraded", reason: "voice-failed", observedAt: at, metrics }
  if (value.incomplete) return { id: "voice", status: "degraded", reason: "voice-incomplete", observedAt: at, metrics }
  return { id: "voice", status: "healthy", reason: "ready", observedAt: at, metrics }
}

async function overlay(health: AdminHealth, host?: AdminHostSignals): Promise<AdminHealth> {
  if (!host?.browser && !host?.voice) return health
  const at = health.generatedAt
  const rows = new Map(health.items.map((item) => [item.id, item]))
  const reads = await Promise.all([
    host.browser
      ? Promise.resolve()
          .then(host.browser)
          .then((value) => browserRow(value, at))
          .catch(() => failed("browser", at))
      : undefined,
    host.voice
      ? Promise.resolve()
          .then(host.voice)
          .then((value) => voiceRow(value, at))
          .catch(() => failed("voice", at))
      : undefined,
  ])
  for (const row of reads) if (row) rows.set(row.id, row)
  return {
    ...health,
    items: health.items.map((item) => rows.get(item.id) ?? item),
  }
}

export async function handleAdminMessage(input: {
  client: KiloClient | null
  directory: string
  message: { type: string } & Record<string, unknown>
  post: Post
  host?: AdminHostSignals
}): Promise<boolean> {
  if (input.message.type !== "requestAdmin") return false
  const requestID = input.message.requestID
  if (typeof requestID !== "string" || !requestID) return true
  if (!input.client) {
    input.post({
      type: "adminResult",
      requestID,
      error: { kind: "offline", message: "Raya is disconnected. Reconnect to check system health." },
    })
    return true
  }
  try {
    const response = await input.client.raya.admin.health({ directory: input.directory })
    if (!response.data) {
      input.post({
        type: "adminResult",
        requestID,
        error: { kind: "error", message: "Raya couldn't read system health. Try again." },
      })
      return true
    }
    const health = await overlay(response.data, input.host)
    const logs = await input.client.raya.admin.logs({ directory: input.directory, limit: "48" }).catch(() => undefined)
    if (!logs?.data) {
      input.post({
        type: "adminResult",
        requestID,
        health,
        error: { kind: "error", message: "Health is available, but diagnostics couldn't be loaded." },
      })
      return true
    }
    input.post({ type: "adminResult", requestID, health, logs: logs.data })
    return true
  } catch {
    input.post({
      type: "adminResult",
      requestID,
      error: { kind: "offline", message: "The connection was interrupted. Reconnect, then try again." },
    })
    return true
  }
}
