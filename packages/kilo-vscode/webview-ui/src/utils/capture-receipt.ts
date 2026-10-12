import type { CaptureReceipt } from "../../../src/shared/second-brain"

export function receipt(value: unknown): value is CaptureReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) &&
    typeof row.project === "string" &&
    row.project.length > 0 &&
    row.project.length <= 4096 &&
    [row.sessionID, row.messageID].every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) &&
    typeof row.receipt === "string" &&
    /^[a-f0-9]{64}$/.test(row.receipt)
  )
}
