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
