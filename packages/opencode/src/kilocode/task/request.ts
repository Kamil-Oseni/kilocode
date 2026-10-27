import { Effect } from "effect"

/** Carry exact owner context without repeated copies or silent truncation. */
export function preserve(...values: (string | undefined)[]) {
  const parts = [...new Set(values.filter((value): value is string => !!value?.trim()))]
  const text = parts.filter((value) => !parts.some((other) => other !== value && other.includes(value))).join("\n\n")
  return text.length > 4000
    ? Effect.fail(
        new Error(
          "The combined owner context exceeds the 4000-character context limit. Omit or shorten only the additional stage context; the original owner request cannot be truncated.",
        ),
      )
    : Effect.succeed(text || undefined)
}

/** Only current owner text can request a read-only status turn. */
export function inspection(request: string | undefined) {
  if (!request) return false
  const text = request
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*>.*$/gm, "")
    .trim()
  return /^(?:please\s+)?read[ -]only\s+(?:status\s+)?(?:check|review|inspection)\b/i.test(text)
}

/** Explicit current-turn restrictions never grant or revoke saved worker authority. */
export function prohibits(request: string | undefined) {
  if (!request) return false
  if (inspection(request)) return true
  const text = request.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "")
  return (
    /\b(?:do not|don't|never)\s+(?:start|run|launch|assign|delegate)(?:\s*(?:,|and|or)\s*(?:start|run|launch|assign|delegate))*\s+(?:(?:any|new|more|the|a|another|additional)\s+){0,3}(?:work|jobs?|workers?|agents?|routines?|tasks?|delegations?)\b(?=\s*(?:[.!?;,]|$)|\s+in\s+this\s+turn\b)/i.test(
      text,
    ) ||
    /\bno\s+(?:(?:corrections?|changes?)\s+(?:or|and)\s+)?(?:(?:new|more|additional)\s+)?(?:delegations?|assignments?)\b(?=\s*(?:[.!?;,]|$)|\s+in\s+this\s+turn\b)/i.test(
      text,
    ) ||
    /\b(?:do not|don't|never)\s+(?:call|use)\s+(?:assign_organization_work|delegate_work)\b(?=\s*(?:[.!?;,]|$)|\s+in\s+this\s+turn\b)/i.test(
      text,
    )
  )
}

/** Honor explicit field omission without interpreting an absent budget as permission to spend. */
export function omits(request: string | undefined, field: "budget" | "deadline" = "budget") {
  if (!request) return false
  const text = request.replace(/```[\s\S]*?```/g, "").replace(/^\s*>.*$/gm, "")
  return (
    [
      ...text.matchAll(
        /\bomit\s+(?:(?:the|any|a)\s+)?((?:budget|deadline)(?:\s*(?:,|and|&)\s*(?:budget|deadline))*)\b/gi,
      ),
    ].some(
      (match) =>
        new RegExp(`\\b${field}\\b`, "i").test(match[1]) &&
        !/\b(?:not|never|don't|cannot|can't)\s+(?:\w+\s+){0,2}$/i.test(text.slice(0, match.index)),
    ) ||
    new RegExp(
      `\\b(?:do not|don't)\\s+(?:set|add|supply|include|invent)\\s+(?:(?:the|a|any)\\s+)?${field}(?=\\s*(?:[.,;:!?]|$)|\\s+(?:key|field|parameter|for|on)\\b)`,
      "i",
    ).test(text)
  )
}

/** Recognize an affirmative handoff requirement without treating prohibitions as requested work. */
export function forward(text: string) {
  return [...text.matchAll(/\b(?:hand(?:ing)?[\s-]?offs?|delegat(?:e[sd]?(?:_work)?|ing|ion))\b/gi)].some(
    (match) =>
      !/\b(?:no|not|never|without|don't|cannot|can't|avoid)\s+(?:\w+\s+){0,2}$/i.test(text.slice(0, match.index)),
  )
}

/** Running a saved team is work assignment, not permission to create or edit workers. */
export function kickoff(request: string | undefined) {
  if (!request) return false
  const changes = request.matchAll(
    /\b(?:create|schedule|add|hire|rename|remove|delete|update|change|configure|enable|disable|pause|resume)\s+(?:(?:a|an|the|my|our|new|existing|saved|standing|recurring)\s+){0,5}(?:teams?|workers?|agents?|routines?|organi[sz]ations?)\b/gi,
  )
  if ([...changes].some((match) => !/(?:do not|don't|never|without)\s*$/i.test(request.slice(0, match.index))))
    return false
  const match =
    /\b(?:start|run|launch|delegate|assign|send|kick off)\s+(?:[\w-]+\s+){0,8}(?:job|workflow|work)\s+(?:through|via|by|to)\s+/i.exec(
      request,
    )
  if (match) {
    const route = request.slice(match.index + match[0].length)
    const named = route.replace(/^(?:(?:my|our|the)\s+)?(?:(?:saved|existing|configured)\s+){0,2}/i, "")
    if (
      /^(?:(?:my|our|the)\s+)?(?:saved|existing|configured)\s+(?:[\w-]+\s+){0,3}(?:worker|team|agent)\b/i.test(route) ||
      /^[A-Z][\w-]*(?:\s+[A-Z][\w-]*)?(?:\s*(?:->|→)\s*[A-Z][\w-]*(?:\s+[A-Z][\w-]*)?){0,5}(?:\s+team)?(?=[.,:;!?]|\s+(?:to|for|with|using|and)\b|$)/.test(
        named,
      )
    )
      return true
  }
  return /\b(?:use|run|launch|start|activate|ask|have|dispatch)\s+(?:(?:my|our|the|this|these)\s+)?(?:(?:saved|existing|configured)\s+){1,2}(?:[\w-]+\s+){0,3}(?:teams?|workers?|agents?|organi[sz]ations?)\b/i.test(
    request,
  )
}
