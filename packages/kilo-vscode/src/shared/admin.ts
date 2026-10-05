import type { RayaAdminHealthResponse, RayaAdminLogsResponse } from "@kilocode/sdk/v2/client"

export type AdminResources = {
  observedAt: number
  process: { pid: number; rss: number; heapUsed: number; heapTotal: number }
  host: { free: number; total: number }
  inference: { active: number; queued: number; bytes: number }
}
export type AdminHealth = RayaAdminHealthResponse & { resources?: AdminResources }
export type AdminRow = AdminHealth["items"][number]
export type AdminLogs = RayaAdminLogsResponse
export type AdminEntry = AdminLogs[number]

export type AdminBrowserSignal = {
  status: "ready" | "locked" | "auth_expired" | "closed" | "unavailable" | "error"
}

export type AdminVoiceSignal = {
  available: boolean
  active: number
  failed: number
  incomplete: number
}

export type AdminUpdateSignal = {
  status: "ready" | "not-checked" | "failed"
}

export type AdminHostSignals = {
  browser?: () => AdminBrowserSignal | Promise<AdminBrowserSignal>
  voice?: () => AdminVoiceSignal | Promise<AdminVoiceSignal>
  updates?: () => AdminUpdateSignal | Promise<AdminUpdateSignal>
}

export type AdminResult = {
  type: "adminResult"
  requestID: string
  health?: AdminHealth
  logs?: AdminLogs
  error?: {
    kind: "offline" | "error"
    message: string
  }
}
