import type { RayaAdminHealthResponse, RayaAdminLogsResponse } from "@kilocode/sdk/v2/client"

export type AdminHealth = RayaAdminHealthResponse
export type AdminRow = AdminHealth["items"][number]
export type AdminLogs = RayaAdminLogsResponse
export type AdminEntry = AdminLogs[number]

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
