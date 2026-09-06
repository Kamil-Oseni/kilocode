export type RunPresence = "working" | "waiting" | "done" | "error" | "idle"

export function runPresence(input: {
  busy?: boolean
  waiting?: boolean
  done?: boolean
  error?: boolean
  acked?: boolean
}): RunPresence {
  if (input.waiting) return "waiting"
  if (input.busy) return "working"
  if (input.error && !input.acked) return "error"
  if (input.done && !input.acked) return "done"
  return "idle"
}

export function presenceLabel(state: RunPresence) {
  if (state === "waiting") return "Waiting on you"
  if (state === "working") return "Working"
  if (state === "done") return "Done"
  if (state === "error") return "Blocked"
  return ""
}
