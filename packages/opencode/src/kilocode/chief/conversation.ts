import type { MessageV2 } from "@/session/message-v2"
import { RayaChief } from "."

export const instruction =
  "This original user turn requests only a greeting or a general introduction to your assistance capabilities. Reply directly and briefly, honoring their restrictions. Describe general capabilities without claiming current access, setup, account, project or device facts. Do not route or use tools, perform actions, start a goal, or claim that a preference was saved."

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
  if (
    /^(?:(?:hi|hello|hey)(?: raya)?[,!. ]+)?(?:what can you help me with|how can you help me|what can you do)[?.!]?$/i.test(
      request.trim(),
    )
  )
    return true
  const rows = request
    .trim()
    .replace(/[.!]$/, "")
    .split(/[.;!]\s*/)
  if (rows.length > 6) return false
  if (
    !/^(?:(?:hi|hello|hey|good morning|good afternoon|good evening)(?:,?\s+raya)?|(?:please )?(?:reply|respond) with (?:one|a) (?:(?:short|brief|friendly) )?greeting|(?:please )?say (?:hi|hello))$/i.test(
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
        /^(?:this is|it's|it is) (?:just |only )?(?:a )?(?:(?:temporary|brief|silent|simple) )?(?:conversation|chat|greeting) (?:check|test)$/i.test(
          row,
        ) ||
        /^(?:please )?(?:reply|respond) with (?:one|a) (?:(?:short|brief|friendly) ){0,3}(?:sentence|greeting)$/i.test(
          row,
        ) ||
        /^no (?:actions|tools|saving)$/i.test(row) ||
        restriction.test(row),
    )
}

/** A supplied chat fact can be acknowledged without saving it or acquiring outside information. */
export function acknowledgement(request: string) {
  if (Buffer.byteLength(request, "utf8") > 1024) return false
  const rows = request
    .trim()
    .replace(/[.!]$/, "")
    .split(/[.;!]\s*/)
  if (!rows.length || rows.length > 5) return false
  const fact =
    /^(?:(?:remember that )?my (?:project )?(?:nickname|name) (?:in this chat|here) is ([\p{L}\p{N}][\p{L}\p{N} '-]{0,79})|(?:please )?call me ([\p{L}\p{N}][\p{L}\p{N} '-]{0,79}) (?:in this chat|here))$/iu
  if (!rows.some((row) => fact.test(row))) return false
  return rows.every((row) => {
    const name = fact.exec(row)
    if (name)
      return !/\b(?:and|then|also|please|read|write|edit|open|turn|save|store|remember|memory|preference)\b/i.test(
        name[1] ?? name[2],
      )
    return (
      /^this is an ordinary conversation$/i.test(row) ||
      /^(?:please )?(?:acknowledge(?: (?:the|that|my) (?:nickname|name))?|reply in one short sentence acknowledging (?:the|that|my) (?:nickname|name))$/i.test(
        row,
      ) ||
      /^(?:please )?(?:do not|don't) (?:(?:use|call) (?:any )?tools(?: or start workers)?|start workers|save (?:this|it)(?: as (?:a )?(?:preference|memory))?)$/i.test(
        row,
      )
    )
  })
}

/** Chat-context replies can honor a blanket no-tools instruction without specialist delegation. */
export function unaided(request: string) {
  const text = request
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/^\s*>.*$/gm, "")
  if (
    !/\b(?:(?:this|our|current)\s+(?:chat|conversation|discussion)|earlier|previously|(?:i|we|you)\s+(?:just\s+)?(?:said|mentioned|agreed))\b/i.test(
      text,
    )
  )
    return false
  const pattern =
    /\b(?:(?:do not|don't|never)\s+(?:use|call|invoke|run)\s+(?:any\s+)?tools?|without\s+(?:(?:using|calling)\s+)?(?:any\s+)?tools?|no\s+tools?)(?:\s+(?:or|and)\s+(?:(?:start|use)\s+)?(?:any\s+)?workers?)?(?=\s*(?:[.!;,?]|$))/gi
  if (
    ![...text.matchAll(pattern)].some(
      (match) => !/\b(?:say|phrase|words|called|named|quoted)\s*$/i.test(text.slice(0, match.index)),
    )
  )
    return false
  return !/(?:^|[.;!?]\s*|\b(?:and|then|also)\s+)(?:please\s+)?(?:read|inspect|open|search|browse|check|fetch|write|edit|modify|delete|remove|rename|create|update|save|store|run|execute|launch|start|stop|turn|set|dim|brighten|switch|fade|activate)\b[^.!?;\n]{0,100}\b(?:files?|repositor(?:y|ies)|repos?|director(?:y|ies)|folders?|disks?|drives?|websites?|browsers?|web|internet|lights?|lamps?|bulbs?|moods?|scenes?|rgb|applications?|programs?|commands?|process(?:es)?|workers?|routines?|organi[sz]ations?|preferences?|memory)\b/i.test(
    text.replace(pattern, ""),
  )
}
