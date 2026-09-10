/** Only a failed cancellation that belongs to this voice operation is recoverable. */
export function cancelled(packet: Record<string, unknown>, events: ReadonlySet<string>) {
  const error = packet.error
  if (!error || typeof error !== "object" || Array.isArray(error)) return false
  if (!("code" in error) || error.code !== "response_cancel_not_active") return false
  return "event_id" in error && typeof error.event_id === "string" && events.has(error.event_id)
}

export function owned(packet: Record<string, unknown>, events: ReadonlySet<string>) {
  const error = packet.error
  return (
    !!error &&
    typeof error === "object" &&
    "event_id" in error &&
    typeof error.event_id === "string" &&
    events.has(error.event_id)
  )
}
