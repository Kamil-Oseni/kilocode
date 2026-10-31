export type Correction = {
  nonce: string
  agentID: string
  runID: string
  sessionID: string
  at: number
}

/** Prepare text only; this cannot send, restart a run, or change its saved requirements. */
export function correction(body: string, target: Correction) {
  if (
    ![target.agentID, target.runID, target.sessionID].every((id) => /^[a-zA-Z0-9_.:-]{1,256}$/.test(id)) ||
    !Number.isSafeInteger(target.at) ||
    Math.abs(target.at) > 8.64e15
  )
    return null
  const reference = `Result reference: run ${target.runID}, conversation ${target.sessionID}.`
  if (body.includes(reference)) return body
  const text = `Please revise your result from ${new Date(target.at).toLocaleString()}.\n${reference}\n\nChanges I want: `
  const next = body ? `${body}\n\n${text}` : text
  return next.length <= 8000 ? next : undefined
}
