export function taskRunning(status: string | undefined) {
  return status === "pending" || status === "running"
}

export function taskVisible(open: boolean | undefined, id: string | undefined) {
  return open ? id : undefined
}

function taskOutputState(output: string) {
  return (
    /^\s*<task\b[^>]*\bstate="([^"]+)"[^>]*>/.exec(output)?.[1] ??
    /^\s*task_id:[^\n]*\nstate:\s*(running|completed|error)\b/.exec(output)?.[1]
  )
}

export function taskResult(output: string | undefined, id: string | undefined) {
  if (id || typeof output !== "string") return
  const state = taskOutputState(output)
  if (state && state !== "completed") return
  const match = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(output)
  if (state && !match) return
  return match?.[1] ?? output
}

/** A compact, historical task status derived from its saved tool result. */
export function taskStatus(status: string | undefined, output: string | undefined) {
  if (taskRunning(status)) return "Working"
  if (status === "error") return "Needs attention"
  if (status !== "completed") return
  if (output && taskOutputState(output) === "running") return "Started in background"
  if (taskResult(output, undefined)?.trim()) return "Report ready"
}

/** Use the routed specialist, never the task title, to choose chat chrome. */
export function agentIcon(role: string | undefined) {
  switch (role?.toLocaleLowerCase()) {
    case "researcher":
    case "explore":
      return "magnifying-glass" as const
    case "designer":
      return "pencil-line" as const
    case "engineer":
    case "coder":
    case "code":
      return "code" as const
    case "accountant":
      return "checklist" as const
    case "reasoner":
      return "brain" as const
    default:
      return "subagent" as const
  }
}

// raya_change start - Milestone D nested thread identity for automatic Chief routing
export function taskAgent(
  input: { subagent_type?: unknown; description?: unknown } | undefined,
  part?: { selectedAgent?: string; selection?: string; displayName?: string },
  state?: { selectedAgent?: string; selection?: string; displayName?: string },
) {
  const selected = part?.selectedAgent ?? state?.selectedAgent
  const requested = typeof input?.subagent_type === "string" ? input.subagent_type : undefined
  const agent = selected ?? requested ?? "auto"
  const description = typeof input?.description === "string" ? input.description : undefined
  const displayName = part?.displayName ?? state?.displayName
  return {
    agent,
    displayName,
    description,
  }
}
// raya_change end

type TaskMetadata = {
  selectedAgent?: string
  selection?: string
  displayName?: string
  "raya.task.authority"?: unknown
}

/** Show a scope only when the backend mirrored a valid saved authority record. */
export function taskAccess(part?: unknown, state?: unknown): "read" | "edit" | "computer" | undefined {
  const key = "raya.task.authority"
  const first = record(part) ? part : undefined
  const source = first && Object.hasOwn(first, key) ? first : record(state) ? state : undefined
  const value = source?.[key]
  if (!record(value) || value.version !== 1) return
  if (value.access === "read" || value.access === "edit" || value.access === "computer") return value.access
}

export function taskAccessLabel(access: NonNullable<ReturnType<typeof taskAccess>>): string {
  if (access === "read") return "Read only"
  if (access === "computer") return "Desktop tools"
  return "Can edit"
}

/** Match the visible task trigger and result when indexing conversation search. */
export function taskSearchText(opts: {
  status: string
  input?: { subagent_type?: unknown; description?: unknown }
  part?: TaskMetadata
  metadata?: TaskMetadata
  output?: string
  child?: string
  title: (agent: string) => string
}) {
  const agent = taskAgent(opts.input, opts.part, opts.metadata)
  const status = taskStatus(opts.status, opts.output)
  return {
    title: agent.displayName ?? opts.title(agent.agent),
    description: agent.displayName ? undefined : agent.description,
    status,
    access: taskAccess(opts.part, opts.metadata),
    result: taskResult(opts.output, taskRunning(opts.status) ? opts.child : undefined),
  }
}

const sources = {
  workflow: "workflow",
  "saved-agent": "saved agent selection",
  "agent-config": "agent configuration",
  "small-config": "small-model configuration",
  "subagent-config": "subagent configuration",
  parent: "parent selection",
} as const

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function source(value: unknown): value is keyof typeof sources {
  return typeof value === "string" && Object.hasOwn(sources, value)
}

function label(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
}

function variant(receipt: Record<string, unknown>, origin: keyof typeof sources) {
  if (receipt.variant === undefined) return receipt.variantSource === "none" ? "" : undefined
  if (
    typeof receipt.variant !== "string" ||
    receipt.variant.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(receipt.variant)
  )
    return
  if (receipt.variantSource !== "model-override" && receipt.variantSource !== origin) return
  return `; Variant ${receipt.variant || "default"} from ${receipt.variantSource === "model-override" ? "model override" : sources[origin]}`
}

function selection(data: Record<string, unknown>) {
  const receipt = data.provenance
  if (
    !record(receipt) ||
    receipt.version !== 1 ||
    receipt.stage !== "selected" ||
    receipt.capability !== "normalized-provider-flag" ||
    !source(receipt.source) ||
    !record(receipt.model) ||
    !record(data.model) ||
    !label(receipt.model.providerID) ||
    !label(receipt.model.modelID) ||
    receipt.model.providerID !== data.model.providerID ||
    receipt.model.modelID !== data.model.modelID ||
    receipt.variant !== data.variant ||
    (data.model.variant !== undefined && data.model.variant !== receipt.variant)
  )
    return
  const suffix = variant(receipt, receipt.source)
  if (suffix === undefined) return
  return `Selected ${receipt.model.providerID}/${receipt.model.modelID} from ${sources[receipt.source]}${suffix}`
}

export function taskModel(part: unknown, state?: unknown) {
  // Read one complete metadata snapshot; never combine provenance from one with a model from another.
  const data = record(part) && Object.hasOwn(part, "provenance") ? part : record(state) ? state : part
  if (!record(data) || !Object.hasOwn(data, "provenance")) return "Model source not recorded"
  return selection(data) ?? "Model selection details unavailable"
}
