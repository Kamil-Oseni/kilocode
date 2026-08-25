export function taskRunning(status: string | undefined) {
  return status === "pending" || status === "running"
}

export function taskVisible(open: boolean | undefined, id: string | undefined) {
  return open ? id : undefined
}

export function taskResult(output: string | undefined, id: string | undefined) {
  if (id || typeof output !== "string") return
  const match = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(output)
  return match?.[1] ?? output
}

// raya_change start - Milestone D nested thread identity for automatic Chief routing
export function taskAgent(
  input: { subagent_type?: unknown; description?: unknown },
  part?: { selectedAgent?: string; selection?: string },
  state?: { selectedAgent?: string; selection?: string },
) {
  const selected = part?.selectedAgent ?? state?.selectedAgent
  const requested = typeof input.subagent_type === "string" ? input.subagent_type : undefined
  const agent = selected ?? requested ?? "auto"
  const selection = part?.selection ?? state?.selection
  const description = typeof input.description === "string" ? input.description : undefined
  return {
    agent,
    description: selection === "auto" ? `Auto → ${agent}${description ? ` · ${description}` : ""}` : description,
  }
}
// raya_change end
