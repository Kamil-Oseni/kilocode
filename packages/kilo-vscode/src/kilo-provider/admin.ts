import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { AdminResult } from "../shared/admin"

type Post = (message: AdminResult) => void

export async function handleAdminMessage(input: {
  client: KiloClient | null
  directory: string
  message: { type: string } & Record<string, unknown>
  post: Post
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
    const health = await input.client.raya.admin.health({ directory: input.directory })
    if (!health.data) {
      input.post({
        type: "adminResult",
        requestID,
        error: { kind: "error", message: "Raya couldn't read system health. Try again." },
      })
      return true
    }
    const logs = await input.client.raya.admin.logs({ directory: input.directory, limit: "48" }).catch(() => undefined)
    if (!logs?.data) {
      input.post({
        type: "adminResult",
        requestID,
        health: health.data,
        error: { kind: "error", message: "Health is available, but diagnostics couldn't be loaded." },
      })
      return true
    }
    input.post({ type: "adminResult", requestID, health: health.data, logs: logs.data })
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
