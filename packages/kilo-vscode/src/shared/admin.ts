import type { RayaAdminHealthResponse, RayaAdminLogsResponse } from "@kilocode/sdk/v2/client"

export type AdminResources = NonNullable<RayaAdminHealthResponse["resources"]>
export type AdminRecovery =
  | {
      status: "available"
      version: string
      target: string
      artifact: { digest: string; size: number }
      binary: { digest: string; size: number }
      observedAt: number
    }
  | { status: "absent"; reason: "active-unavailable" | "earlier-package-unavailable" }
  | { status: "invalid"; reason: "installation-failed" | "active-mismatch" | "verification-failed" }
  | { status: "in-progress"; reason: "installation-retained" }
export type AdminHealth = RayaAdminHealthResponse & { recovery?: AdminRecovery }
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
  recovery?: () => AdminRecovery | Promise<AdminRecovery>
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
