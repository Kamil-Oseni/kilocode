type State = { status: string; input?: Record<string, unknown>; output?: string; metadata?: Record<string, unknown> }

export type ChiefPart = { id: string; tool: string; state: State; metadata?: Record<string, unknown> }

export type ChiefBranch = {
  id: string
  name: string
  specialist: string
  access?: "read" | "edit"
  objective?: string
  report?: string
  state: "planned" | "working" | "ready" | "reviewed" | "failed" | "cancelled" | "unknown"
}

export type ChiefActivity = { branches: ChiefBranch[]; synthesized: boolean }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function metadata(part: ChiefPart) {
  return part.metadata ?? part.state.metadata ?? {}
}

function inspect(part: ChiefPart) {
  if (part.state.status !== "completed" || !part.state.output) return []
  try {
    const data = object(JSON.parse(part.state.output))
    if (!Array.isArray(data?.branches)) return []
    return data.branches.flatMap(
      (value): { id: string; state: ChiefBranch["state"]; reviewed: boolean; report?: string }[] => {
        const item = object(value)
        const id = text(item?.id)
        const state = item?.state
        if (!id || !["planned", "admitted", "completed", "failed", "cancelled", "unknown"].includes(String(state)))
          return []
        return [
          {
            id,
            state: state === "admitted" ? "working" : state === "completed" ? "ready" : (state as ChiefBranch["state"]),
            reviewed: item?.reviewed === true,
            ...(text(item?.report) ? { report: text(item?.report)?.slice(0, 240) } : {}),
          },
        ]
      },
    )
  } catch {
    return []
  }
}

function planned(value: unknown): ChiefBranch[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return
  const branches = value.flatMap((raw): ChiefBranch[] => {
    const item = object(raw)
    const id = text(item?.id)
    const name = text(item?.name)
    const specialist = text(item?.specialist)
    const brief = object(item?.brief)
    const access = item?.access === "read" || item?.access === "edit" ? item.access : undefined
    return id && name && specialist
      ? [
          {
            id,
            name,
            specialist,
            ...(access ? { access } : {}),
            ...(text(brief?.objective) ? { objective: text(brief?.objective) } : {}),
            state: "planned",
          },
        ]
      : []
  })
  if (branches.length !== value.length || new Set(branches.map((item) => item.id)).size !== branches.length) return
  return branches
}

function status(
  report: ReturnType<typeof inspect>[number] | undefined,
  task: ChiefPart | undefined,
  reviewed: boolean,
) {
  const state = report?.state
  const outcome = task?.state.output?.match(/<task\s+[^>]*state="(completed|error)"/)?.[1]
  if (state === "unknown" || state === "cancelled" || state === "failed") return state
  if (task?.state.status === "error" || outcome === "error") return "failed" as const
  if (reviewed || report?.reviewed) return "reviewed" as const
  if (state === "ready" || outcome === "completed") return "ready" as const
  if (state === "working" || task) return "working" as const
  return "planned" as const
}

function related(plan: ChiefPart, part: ChiefPart) {
  const origin = metadata(plan)
  const receipt = metadata(part)
  return (
    part.id !== plan.id &&
    part.tool.startsWith("chief_") &&
    receipt.requestID === origin.requestID &&
    receipt.goalCreatedAt === origin.goalCreatedAt
  )
}

function receipts(plan: ChiefPart, branches: ChiefBranch[], later: readonly ChiefPart[]) {
  const reports = new Map<string, ReturnType<typeof inspect>[number]>()
  const reviews = new Set<string>()
  let inspected = false
  for (const part of later) {
    if (part.tool === "chief_inspect" && related(plan, part)) {
      const items = inspect(part)
      if (items.length !== branches.length || items.some((item) => !branches.some((branch) => branch.id === item.id)))
        continue
      inspected = true
      for (const item of items) reports.set(item.id, item)
    }
    if (inspected && part.tool === "chief_review" && part.state.status === "completed") {
      const receipt = metadata(part)
      if ((receipt.requestID !== undefined || receipt.goalCreatedAt !== undefined) && !related(plan, part)) continue
      const id = text(part.state.input?.branch_id) ?? text(metadata(part).branchID)
      if (id && branches.some((branch) => branch.id === id)) reviews.add(id)
    }
  }
  return { reports, reviews }
}

/** Project one saved Chief plan and later receipts into calm, truthful chat status. */
export function chiefActivity(plan: ChiefPart, parts: readonly ChiefPart[]): ChiefActivity | undefined {
  if (plan.tool !== "chief_plan" || plan.state.status !== "completed") return
  const branches = planned(plan.state.input?.proposals)
  if (!branches) return

  const request = metadata(plan).requestID
  const goal = metadata(plan).goalCreatedAt
  if (typeof request !== "string" || typeof goal !== "number") return
  const index = parts.findIndex((part) => part.id === plan.id)
  if (index < 0) return
  const tail = parts.slice(index + 1)
  const next = tail.findIndex((part) => part.tool === "chief_plan" && part.state.status === "completed")
  const later = next < 0 ? tail : tail.slice(0, next)
  const { reports, reviews } = receipts(plan, branches, later)

  const state = branches.map((branch): ChiefBranch => {
    const report = reports.get(branch.id)
    const tasks = later.filter((part) => part.tool === "task" && part.state.input?.branch_id === branch.id)
    const task = tasks.at(-1)
    const current = status(report, task, reviews.has(branch.id))
    return {
      ...branch,
      state: current,
      ...((current === "ready" || current === "reviewed") && report?.report ? { report: report.report } : {}),
    }
  })
  const synthesized = later.some(
    (part) => part.tool === "chief_synthesize" && part.state.status === "completed" && related(plan, part),
  )
  return { branches: state, synthesized }
}
