/** Local media identity. Source and target name voice request IDs, never provider capabilities. */
export type Handoff = Readonly<{
  version: 1
  id: string
  sessionID: string
  source: string
  target: string
}>

export type HandoffAck = Handoff & Readonly<{ phase: "prepared" | "cutover" }>

/** Reject unknown fields and incomplete identities before touching either media operation. */
export function valid(value: unknown): value is Handoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const keys = ["id", "sessionID", "source", "target"] as const
  const fields = Object.keys(item)
  if (fields.length !== 5 || fields.some((key) => !["version", ...keys].includes(key)) || item.version !== 1)
    return false
  if (
    keys.some((key) => {
      const field = item[key]
      return typeof field !== "string" || field.length < 1 || field.length > 128 || /[^a-zA-Z0-9_-]/.test(field)
    })
  )
    return false
  return item.source !== item.target
}
