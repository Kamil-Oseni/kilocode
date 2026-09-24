type State = { status: string; input?: Record<string, unknown>; output?: string; metadata?: Record<string, unknown> }

export type ChiefPart = {
  id: string
  sessionID?: string
  tool: string
  state: State
  metadata?: Record<string, unknown>
}

export type ChiefBranch = {
  id: string
  name: string
  specialist: string
  access?: "read" | "edit"
  objective?: string
  report?: string
  state: "planned" | "working" | "ready" | "pending" | "reviewed" | "failed" | "cancelled" | "unknown"
}

export type ChiefActivity = { branches: ChiefBranch[]; synthesized: boolean }

export type ChiefEvent = { name: string; specialist?: string; status: string }

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
      (
        value,
      ): {
        id: string
        state: ChiefBranch["state"]
        reviewed: boolean
        isolated: boolean
        integration?: string
        report?: string
      }[] => {
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
            isolated: object(item?.edits) !== undefined,
            ...(text(item?.integration) ? { integration: text(item?.integration) } : {}),
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

function editing(
  report: ReturnType<typeof inspect>[number] | undefined,
  reviewed: boolean,
  access: ChiefBranch["access"],
) {
  if (access !== "edit" || !report?.isolated) return
  if (report.integration === "unknown") return "unknown" as const
  if ((reviewed || report.reviewed) && report.integration !== "integrated") return "pending" as const
}

function status(
  report: ReturnType<typeof inspect>[number] | undefined,
  task: ChiefPart | undefined,
  reviewed: boolean,
  access: ChiefBranch["access"],
) {
  const state = report?.state
  const outcome = task?.state.output?.match(/<task\s+[^>]*state="(completed|error)"/)?.[1]
  if (state === "unknown" || state === "cancelled" || state === "failed") return state
  if (task?.state.status === "error" || outcome === "error") return "failed" as const
  const edit = editing(report, reviewed, access)
  if (edit) return edit
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

function started(plan: ChiefPart, part: ChiefPart, branches: ChiefBranch[], prior: readonly ChiefPart[]) {
  if (part.tool !== "task" || part.state.status !== "completed") return
  const source = metadata(plan)
  const receipt = metadata(part)
  const id = text(part.state.input?.branch_id)
  const branch = branches.find((item) => item.id === id)
  const child = text(receipt.sessionId)
  if (
    !branch ||
    !child ||
    !text(receipt.childMessageID) ||
    !plan.sessionID ||
    part.sessionID !== plan.sessionID ||
    receipt.parentSessionId !== plan.sessionID ||
    receipt.requestID !== source.requestID ||
    receipt.goalCreatedAt !== source.goalCreatedAt ||
    receipt.selectedAgent !== branch.specialist ||
    receipt.background !== true ||
    part.state.input?.background !== true ||
    !part.state.output?.startsWith(`<task id="${child}" state="running">\n<summary>Background task started</summary>\n`)
  )
    return
  if (
    prior.some(
      (item) => item.tool === "task" && text(item.state.input?.branch_id) === id && started(plan, item, branches, []),
    )
  )
    return []
  return [{ name: branch.name, specialist: branch.specialist, status: "Started" }]
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
    const current = status(report, task, reviews.has(branch.id), branch.access)
    return {
      ...branch,
      state: current,
      ...((current === "ready" || current === "pending" || current === "reviewed") && report?.report
        ? { report: report.report }
        : {}),
    }
  })
  const synthesized = later.some(
    (part) => part.tool === "chief_synthesize" && part.state.status === "completed" && related(plan, part),
  )
  return { branches: state, synthesized }
}

function changes(
  rows: ReturnType<typeof inspect>,
  branches: ChiefBranch[],
  reports: Map<string, ReturnType<typeof inspect>[number]>,
): ChiefEvent[] {
  return branches.flatMap((branch): ChiefEvent[] => {
    const row = rows.find((item) => item.id === branch.id)!
    const old = reports.get(branch.id)
    if (row.integration === "unknown" && old?.integration !== "unknown")
      return [{ name: branch.name, specialist: branch.specialist, status: "Apply status unknown" }]
    if (row.integration === "integrated" && old?.integration !== "integrated")
      return [{ name: branch.name, specialist: branch.specialist, status: "Applied" }]
    if (row.state === old?.state || row.state === "planned") return []
    const labels: Partial<Record<ChiefBranch["state"], string>> = {
      working: "Working",
      ready: branch.access === "edit" && row.isolated ? "Changes ready" : "Report ready",
      failed: "Needs attention",
      cancelled: "Stopped",
      unknown: "Status unknown",
    }
    const status = labels[row.state]
    return status ? [{ name: branch.name, specialist: branch.specialist, status }] : []
  })
}

function reviewEvent(
  part: ChiefPart,
  prior: readonly ChiefPart[],
  plan: ChiefPart,
  branches: ChiefBranch[],
  reports: Map<string, ReturnType<typeof inspect>[number]>,
): ChiefEvent[] | undefined {
  const id = text(metadata(part).branchID)
  const branch = branches.find((item) => item.id === id)
  if (!branch || !reports.has(branch.id)) return
  if (
    prior.some(
      (item) =>
        item.tool === "chief_review" &&
        item.state.status === "completed" &&
        related(plan, item) &&
        metadata(item).branchID === id,
    )
  )
    return []
  return [
    {
      name: branch.name,
      specialist: branch.specialist,
      status: branch.access === "edit" ? "Ready to apply" : "Reviewed",
    },
  ]
}

/** Anchor visible Chief progress to the saved receipt that first established each fact. */
export function chiefReceipt(part: ChiefPart, parts: readonly ChiefPart[]): ChiefEvent[] | undefined {
  if (!["task", "chief_inspect", "chief_review", "chief_synthesize"].includes(part.tool)) return
  const index = parts.findIndex((item) => item.id === part.id)
  const receipt = parts[index]
  if (!receipt || receipt.tool !== part.tool || receipt.state.status !== "completed") return
  const start = parts
    .slice(0, index)
    .findLastIndex((item) => item.tool === "chief_plan" && item.state.status === "completed")
  if (start < 0) return
  const plan = parts[start]
  const branches = planned(plan.state.input?.proposals)
  if (!branches || typeof metadata(plan).requestID !== "string" || typeof metadata(plan).goalCreatedAt !== "number")
    return
  const prior = parts.slice(start + 1, index)
  if (receipt.tool === "task") return started(plan, receipt, branches, prior)
  if (!related(plan, receipt)) return
  const reports = new Map<string, ReturnType<typeof inspect>[number]>()
  const valid = (item: ChiefPart) => {
    if (item.tool !== "chief_inspect" || !related(plan, item)) return
    const rows = inspect(item)
    if (
      rows.length !== branches.length ||
      new Set(rows.map((row) => row.id)).size !== rows.length ||
      rows.some((row) => !branches.some((branch) => branch.id === row.id))
    )
      return
    return rows
  }
  for (const item of prior) {
    const rows = valid(item)
    if (rows) for (const row of rows) reports.set(row.id, row)
  }
  if (receipt.tool === "chief_inspect") {
    const rows = valid(receipt)
    if (!rows) return
    return changes(rows, branches, reports)
  }
  if (receipt.tool === "chief_review") return reviewEvent(receipt, prior, plan, branches, reports)
  if (
    prior.some((item) => item.tool === "chief_synthesize" && item.state.status === "completed" && related(plan, item))
  )
    return []
  return [{ name: "Specialists", status: "Reports combined" }]
}
