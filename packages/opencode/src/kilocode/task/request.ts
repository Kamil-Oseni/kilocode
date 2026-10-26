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
    if (
      /^(?:(?:my|our|the)\s+)?(?:saved|existing|configured)\s+(?:[\w-]+\s+){0,3}(?:worker|team|agent)\b/i.test(route) ||
      /^[A-Z][\w-]*(?:\s+[A-Z][\w-]*)?(?=[.,:;!?]|\s+(?:to|for|with|using|and)\b|$)/.test(route)
    )
      return true
  }
  return /\b(?:use|run|launch|start|activate|ask|have|dispatch)\s+(?:(?:my|our|the|this|these)\s+)?(?:(?:saved|existing|configured)\s+){1,2}(?:[\w-]+\s+){0,3}(?:teams?|workers?|agents?|organi[sz]ations?)\b/i.test(
    request,
  )
}
