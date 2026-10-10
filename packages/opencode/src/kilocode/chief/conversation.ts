import type { MessageV2 } from "@/session/message-v2"
import { RayaChief } from "."

export const instruction =
  "This original user turn requests only a greeting. Reply directly with a brief greeting, honoring their restrictions. Do not route or use tools, perform actions, start a goal, or claim that a preference was saved."

/** Only the current root Auto request can omit initial workflow acquisition. */
export function supplied(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; parentID?: string; metadata?: Record<string, unknown> },
  user: string,
  original?: string,
) {
  if (
    session.parentID ||
    RayaChief.phase(session.metadata) !== "route" ||
    session.metadata?.["raya.goal.open"] === true
  )
    return false
  const current = messages.findLast((row) => row.info.role === "user")
  if (!current || current.info.role !== "user" || current.info.id !== user || current.info.sessionID !== session.id)
    return false
  if (current.info.agent !== "auto" || current.info.format?.type === "json_schema") return false
  if (!current.parts.length || current.parts.some((part) => part.type !== "text" || part.synthetic)) return false
  const request = RayaChief.requestText(current.parts)
  return (
    request === RayaChief.request(session.metadata) &&
    (original === undefined || request === original) &&
    greeting(request)
  )
}

/** Supplied conversational intent grants no acquisition, preference-save or goal authority. */
export function greeting(request: string) {
  if (Buffer.byteLength(request, "utf8") > 512) return false
  const rows = request
    .trim()
    .replace(/[.!]$/, "")
    .split(/[.;!]\s*/)
  if (rows.length > 6) return false
  if (
    !/^(?:(?:hi|hello|hey|good morning|good afternoon|good evening)|(?:please )?(?:reply|respond) with (?:one|a) (?:(?:short|brief|friendly) )?greeting|(?:please )?say (?:hi|hello))$/i.test(
      rows[0],
    )
  )
    return false
  const action =
    "(?:save (?:this|it)(?: as (?:a )?(?:preference|memory))?|(?:perform|take) any actions|(?:use|call) (?:any )?tools|change anything)"
  const restriction = new RegExp(`^(?:please )?(?:do not|don't) ${action}(?: (?:or|and) ${action})*$`, "i")
  return rows
    .slice(1)
    .every(
      (row) =>
        /^(?:this is|it's|it is) (?:just |only )?(?:a )?(?:temporary |brief )?(?:conversation|chat|greeting) (?:check|test)$/i.test(
          row,
        ) ||
        /^no (?:actions|tools|saving)$/i.test(row) ||
        restriction.test(row),
    )
}
