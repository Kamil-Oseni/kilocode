/** A model-facing example, not an inferred or automatically executed continuation. */
export function example(id: string) {
  return `<task_recovery>${JSON.stringify({
    kind: "tool",
    name: "task",
    arguments: {
      task_id: id,
      prompt:
        "Continue the same assigned objective. Correct missing or failed work and verify the actual result with authorized tools.",
    },
  })}</task_recovery>`
}

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
    "Put the retained ID in the task_id argument itself, not only in prompt or brief text. Replace the example prompt with the concrete continuation or correction needed; this example does not execute work or grant permission.",
    example(sessionID),
    "Keep the same authorized access, including edit access when verifying an edit task. Separate fresh children remain appropriate for distinct necessary work.",
  ].join(" ")
}
