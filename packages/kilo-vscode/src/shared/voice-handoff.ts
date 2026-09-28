/** Local media identity. Source and target name voice request IDs, never provider capabilities. */
export type Handoff = Readonly<{
  version: 1
  id: string
  sessionID: string
  source: string
  target: string
}>

export type HandoffAck = Handoff & Readonly<{ phase: "prepared" | "cutover" }>

export type HandoffQuiet = Handoff & Readonly<{ phase: "quiesced"; epoch: number }>

export type HandoffCommand =
  | { type: "speechOpenAIHandoffPrepare"; handoff: Handoff }
  | { type: "speechOpenAIHandoffAnswer"; handoff: Handoff; sdp: string }
  | { type: "speechOpenAIHandoffQuiesce"; handoff: Handoff }
  | { type: "speechOpenAIHandoffCutover"; quiet: HandoffQuiet }
  | { type: "speechOpenAIHandoffRetire"; handoff: Handoff }
  | { type: "speechOpenAIHandoffNotice"; handoff: Handoff; reason: "unavailable" | "activity" | "cleanup" }
  | { type: "speechOpenAIHandoffCancel"; handoff: Handoff; restore: boolean }

export type HandoffEvent =
  | { type: "speechOpenAIHandoffOffer"; handoff: Handoff; sdp: string }
  | { type: "speechOpenAIHandoffPrepared"; ack: HandoffAck }
  | { type: "speechOpenAIHandoffQuiesced"; quiet: HandoffQuiet }
  | { type: "speechOpenAIHandoffCutoverAck"; ack: HandoffAck }
  | { type: "speechOpenAIHandoffRetired"; handoff: Handoff; confirmed: boolean }
  | {
      type: "speechOpenAIHandoffCancel"
      handoff: Handoff
      reason: "cancelled" | "unavailable" | "activity" | "cleanup"
    }

/** Compare the complete local identity without inspecting provider capabilities. */
export function same(a: Handoff, b: Handoff): boolean {
  return (
    a.version === b.version &&
    a.id === b.id &&
    a.sessionID === b.sessionID &&
    a.source === b.source &&
    a.target === b.target
  )
}

export function ack(value: unknown, phase: HandoffAck["phase"]): value is HandoffAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const fields = Object.keys(item)
  if (
    fields.length !== 6 ||
    fields.some((key) => !["version", "id", "sessionID", "source", "target", "phase"].includes(key)) ||
    item.phase !== phase
  )
    return false
  return valid(base(item))
}

export function quiet(value: unknown): value is HandoffQuiet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const fields = Object.keys(item)
  if (
    fields.length !== 7 ||
    fields.some((key) => !["version", "id", "sessionID", "source", "target", "phase", "epoch"].includes(key)) ||
    item.phase !== "quiesced" ||
    !Number.isSafeInteger(item.epoch) ||
    Number(item.epoch) < 0
  )
    return false
  return valid(base(item))
}

function base(item: Record<string, unknown>) {
  return { version: item.version, id: item.id, sessionID: item.sessionID, source: item.source, target: item.target }
}

export function event(value: unknown): value is HandoffEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  switch (item.type) {
    case "speechOpenAIHandoffOffer":
      return fields(item, ["handoff", "sdp"]) && valid(item.handoff) && sdp(item.sdp)
    case "speechOpenAIHandoffPrepared":
      return fields(item, ["ack"]) && ack(item.ack, "prepared")
    case "speechOpenAIHandoffQuiesced":
      return fields(item, ["quiet"]) && quiet(item.quiet)
    case "speechOpenAIHandoffCutoverAck":
      return fields(item, ["ack"]) && ack(item.ack, "cutover")
    case "speechOpenAIHandoffRetired":
      return fields(item, ["handoff", "confirmed"]) && valid(item.handoff) && typeof item.confirmed === "boolean"
    case "speechOpenAIHandoffCancel":
      return (
        fields(item, ["handoff", "reason"]) &&
        valid(item.handoff) &&
        typeof item.reason === "string" &&
        ["cancelled", "unavailable", "activity", "cleanup"].includes(item.reason)
      )
    default:
      return false
  }
}

export function command(value: unknown): value is HandoffCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  switch (item.type) {
    case "speechOpenAIHandoffPrepare":
    case "speechOpenAIHandoffQuiesce":
    case "speechOpenAIHandoffRetire":
      return fields(item, ["handoff"]) && valid(item.handoff)
    case "speechOpenAIHandoffAnswer":
      return fields(item, ["handoff", "sdp"]) && valid(item.handoff) && sdp(item.sdp)
    case "speechOpenAIHandoffCutover":
      return fields(item, ["quiet"]) && quiet(item.quiet)
    case "speechOpenAIHandoffCancel":
      return fields(item, ["handoff", "restore"]) && valid(item.handoff) && typeof item.restore === "boolean"
    case "speechOpenAIHandoffNotice":
      return (
        fields(item, ["handoff", "reason"]) &&
        valid(item.handoff) &&
        typeof item.reason === "string" &&
        ["unavailable", "activity", "cleanup"].includes(item.reason)
      )
    default:
      return false
  }
}

function fields(item: Record<string, unknown>, keys: string[]) {
  const fields = Object.keys(item)
  return fields.length === keys.length + 1 && fields.every((key) => key === "type" || keys.includes(key))
}

function sdp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 262_144
}

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
