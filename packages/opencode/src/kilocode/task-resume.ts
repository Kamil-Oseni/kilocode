export function resumeHint(sessionID: string, state?: "running") {
  if (state === "running")
    return [
      `Retain task_id="${sessionID}" for follow-up on this same objective after the child finishes.`,
      "The child is active: do not poll, nudge, or resume it just to request progress; wait for its completion update.",
      "If genuinely new context must be sent while active, use this existing task_id rather than create a replacement child.",
      "Keep the same authorized access, including edit access when verifying an edit task.",
    ].join(" ")
  return [
    `This subagent session can be resumed: call the task tool again with task_id="${sessionID}"`,
    `and a prompt describing how to continue or recover. Its prior context is preserved.`,
    "For follow-up work on the same assigned objective, reuse this task_id instead of creating another child.",
    "Keep the same authorized access, including edit access when verifying an edit task. Separate fresh children remain appropriate for distinct necessary work.",
  ].join(" ")
}
