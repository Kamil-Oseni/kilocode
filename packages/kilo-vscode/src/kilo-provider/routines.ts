import type { KiloClient } from "@kilocode/sdk/v2/client"

function english(when: string | undefined) {
  const text = (when ?? "").trim().toLowerCase()
  if (!text || /when i ask|manual|just when/i.test(text)) return { kind: "manual" as const }
  const once = text.match(/in (\d+)\s*(minute|min|hour|hr)s?/)
  if (once) {
    const n = Number(once[1])
    const ms = once[2]!.startsWith("h") ? n * 3_600_000 : n * 60_000
    return { kind: "once" as const, at: Date.now() + ms }
  }
  const hour = text.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  const weekday = /weekday|monday|tue|wed|thu|fri/.test(text)
  if (hour) {
    let h = Number(hour[1])
    const m = Number(hour[2] ?? "0")
    const ap = hour[3]
    if (ap === "pm" && h < 12) h += 12
    if (ap === "am" && h === 12) h = 0
    return { kind: "cron" as const, expr: `${m} ${h} * * ${weekday ? "1-5" : "*"}` }
  }
  if (/every morning|daily/.test(text)) return { kind: "cron" as const, expr: "0 9 * * *" }
  return { kind: "manual" as const }
}

export async function handleRoutineMessage(input: {
  message: { type: string } & Record<string, unknown>
  client: KiloClient | null
  directory: string
  post: (msg: unknown) => void
  track?: (sessionID: string) => void
}): Promise<boolean> {
  const type = input.message.type
  if (
    type !== "routineList" &&
    type !== "routineCreate" &&
    type !== "routineUpdate" &&
    type !== "routineRun" &&
    type !== "routineRuns"
  ) {
    return false
  }
  if (!input.client) {
    input.post({ type: "routineState", error: "Raya is not connected." })
    return true
  }
  const dir = input.directory
  const kilo = input.client.kilocode.routine
  if (type === "routineList") {
    const [agents, templates] = await Promise.all([
      kilo.list({ directory: dir }, { throwOnError: true }),
      kilo.templates({ directory: dir }, { throwOnError: true }),
    ])
    input.post({ type: "routineState", agents: agents.data, templates: templates.data })
    return true
  }
  if (type === "routineCreate") {
    const when = typeof input.message.when === "string" ? input.message.when : undefined
    const name = typeof input.message.name === "string" ? input.message.name : undefined
    const role = typeof input.message.role === "string" ? input.message.role : undefined
    const objective = typeof input.message.objective === "string" ? input.message.objective : undefined
    const capabilities = Array.isArray(input.message.capabilities)
      ? input.message.capabilities.filter((item): item is string => typeof item === "string")
      : undefined
    const plan = typeof input.message.plan === "string" ? input.message.plan : undefined
    const created = await kilo.create(
      {
        directory: dir,
        name,
        role,
        objective,
        capabilities,
        schedule: typeof input.message.cron === "string" ? { kind: "cron", expr: input.message.cron } : english(when),
        enabled: input.message.enabled !== false,
        plan,
      },
      { throwOnError: true },
    )
    const id = created.data?.id
    if (input.message.runNow && id) {
      const run = await kilo.run({ directory: dir, agentID: id }, { throwOnError: true })
      const sessionID = run.data?.sessionID
      if (sessionID) input.track?.(sessionID)
    }
    await refresh(kilo, dir, input.post)
    return true
  }
  if (type === "routineUpdate") {
    await kilo.update(
      {
        directory: dir,
        agentID: String(input.message.agentID),
        enabled: typeof input.message.enabled === "boolean" ? input.message.enabled : undefined,
        name: typeof input.message.name === "string" ? input.message.name : undefined,
        role: typeof input.message.role === "string" ? input.message.role : undefined,
        objective: typeof input.message.objective === "string" ? input.message.objective : undefined,
        plan: typeof input.message.plan === "string" ? input.message.plan : undefined,
        note: typeof input.message.note === "string" ? input.message.note : undefined,
      },
      { throwOnError: true },
    )
    await refresh(kilo, dir, input.post)
    return true
  }
  if (type === "routineRun") {
    const run = await kilo.run({ directory: dir, agentID: String(input.message.agentID) }, { throwOnError: true })
    const sessionID = run.data?.sessionID
    if (sessionID) input.track?.(sessionID)
    await refresh(kilo, dir, input.post)
    if (typeof input.message.agentID === "string") {
      const history = await kilo.runs({ directory: dir, agentID: input.message.agentID }, { throwOnError: true })
      input.post({ type: "routineRuns", agentID: input.message.agentID, runs: history.data })
    }
    return true
  }
  const history = await kilo.runs({ directory: dir, agentID: String(input.message.agentID) }, { throwOnError: true })
  input.post({ type: "routineRuns", agentID: input.message.agentID, runs: history.data })
  return true
}

async function refresh(kilo: KiloClient["kilocode"]["routine"], dir: string, post: (msg: unknown) => void) {
  const agents = await kilo.list({ directory: dir }, { throwOnError: true })
  post({ type: "routineState", agents: agents.data })
}
