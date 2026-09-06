import type { KiloClient } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../kilo-provider-utils"

type Msg = { type: string } & Record<string, unknown>
type Kilo = KiloClient["kilocode"]["routine"]
type Ctx = {
  message: Msg
  kilo: Kilo
  dir: string
  post: (msg: unknown) => void
  track?: (sessionID: string) => void
}

type Listed = { id: string }

export function english(when: string | undefined) {
  const text = (when ?? "").trim().toLowerCase()
  if (!text || /when i ask|manual|just when/i.test(text)) return { kind: "manual" as const }
  const once = text.match(/in (\d+)\s*(minute|min|hour|hr)s?/)
  if (once) {
    const n = Number(once[1])
    const ms = once[2]!.startsWith("h") ? n * 3_600_000 : n * 60_000
    return { kind: "once" as const, at: Date.now() + ms }
  }
  if (/ci fail|github action|when ci fails/.test(text)) {
    const branch = text.match(/on ([a-z0-9._/-]+)/i)?.[1]
    return { kind: "event" as const, source: "ci", filter: branch === "main" || branch === "master" ? branch : undefined }
  }
  const hour = text.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
  const weekday = /weekday|monday|tue|wed|thu|fri/.test(text)
  if (hour) {
    const ap = hour[3]
    const raw = Number(hour[1])
    const h = ap === "pm" && raw < 12 ? raw + 12 : ap === "am" && raw === 12 ? 0 : raw
    const m = Number(hour[2] ?? "0")
    return { kind: "cron" as const, expr: `${m} ${h} * * ${weekday ? "1-5" : "*"}` }
  }
  if (/every morning|daily/.test(text)) return { kind: "cron" as const, expr: "0 9 * * *" }
  return { kind: "manual" as const }
}

export function reason(err: unknown) {
  const text = getErrorMessage(err)
  if (text && !/^POST http/i.test(text) && text !== "Bad Request" && text !== "{}") return text
  return "Could not save that routine. Accountant jobs need Money tools checked. Inbox jobs need Messages tools checked."
}

function owned(type: string) {
  return (
    type === "routineList" ||
    type === "routineCreate" ||
    type === "routineUpdate" ||
    type === "routineRun" ||
    type === "routineRuns" ||
    type === "routineRemove"
  )
}

function model(msg: Msg) {
  const providerID = typeof msg.providerID === "string" ? msg.providerID : undefined
  const id = typeof msg.modelID === "string" ? msg.modelID : undefined
  if (!providerID || !id) return
  return { providerID, id }
}

function tools(msg: Msg) {
  if (!Array.isArray(msg.tools)) return
  return msg.tools.filter((item): item is string => typeof item === "string")
}

function access(msg: Msg) {
  if (msg.access === "full" || msg.access === "brief") return msg.access
}

async function history(kilo: Kilo, dir: string, post: (msg: unknown) => void, items: Listed[]) {
  for (const item of items) {
    const runs = await kilo.runs({ directory: dir, agentID: item.id }, { throwOnError: true })
    post({ type: "routineRuns", agentID: item.id, runs: runs.data })
  }
}

async function list(ctx: Ctx) {
  const [agents, templates] = await Promise.all([
    ctx.kilo.list({ directory: ctx.dir }, { throwOnError: true }),
    ctx.kilo.templates({ directory: ctx.dir }, { throwOnError: true }),
  ])
  ctx.post({ type: "routineState", agents: agents.data, templates: templates.data })
  await history(ctx.kilo, ctx.dir, ctx.post, (agents.data ?? []) as Listed[])
}

async function create(ctx: Ctx) {
  const msg = ctx.message
  const when = typeof msg.when === "string" ? msg.when : undefined
  const capabilities = Array.isArray(msg.capabilities)
    ? msg.capabilities.filter((item): item is string => typeof item === "string")
    : undefined
  const created = await ctx.kilo.create(
    {
      directory: ctx.dir,
      name: typeof msg.name === "string" ? msg.name : undefined,
      role: typeof msg.role === "string" ? msg.role : undefined,
      objective: typeof msg.objective === "string" ? msg.objective : undefined,
      capabilities,
      schedule: typeof msg.cron === "string" ? { kind: "cron", expr: msg.cron } : english(when),
      enabled: msg.enabled !== false,
      plan: typeof msg.plan === "string" ? msg.plan : undefined,
      model: model(msg),
      access: access(msg),
      tools: tools(msg),
    },
    { throwOnError: true },
  )
  const id = created.data?.id
  if (msg.runNow && id) {
    const run = await ctx.kilo.run({ directory: ctx.dir, agentID: id }, { throwOnError: true })
    const sessionID = run.data?.sessionID
    if (sessionID) {
      ctx.track?.(sessionID)
      ctx.post({ type: "routineStarted", sessionID, agentID: id })
    }
  }
  await refresh(ctx)
}

async function update(ctx: Ctx) {
  const msg = ctx.message
  await ctx.kilo.update(
    {
      directory: ctx.dir,
      agentID: String(msg.agentID),
      enabled: typeof msg.enabled === "boolean" ? msg.enabled : undefined,
      name: typeof msg.name === "string" ? msg.name : undefined,
      role: typeof msg.role === "string" ? msg.role : undefined,
      objective: typeof msg.objective === "string" ? msg.objective : undefined,
      plan: typeof msg.plan === "string" ? msg.plan : undefined,
      note: typeof msg.note === "string" ? msg.note : undefined,
      model: model(msg),
      access: access(msg),
      tools: tools(msg),
    },
    { throwOnError: true },
  )
  await refresh(ctx)
}

async function drop(ctx: Ctx) {
  await ctx.kilo.remove({ directory: ctx.dir, agentID: String(ctx.message.agentID) }, { throwOnError: true })
  await refresh(ctx)
}

async function fire(ctx: Ctx) {
  const id = String(ctx.message.agentID)
  const run = await ctx.kilo.run({ directory: ctx.dir, agentID: id }, { throwOnError: true })
  const sessionID = run.data?.sessionID
  if (sessionID) {
    ctx.track?.(sessionID)
    ctx.post({ type: "routineStarted", sessionID, agentID: id })
  }
  await refresh(ctx)
}

async function one(ctx: Ctx) {
  const agentID = String(ctx.message.agentID)
  const runs = await ctx.kilo.runs({ directory: ctx.dir, agentID }, { throwOnError: true })
  ctx.post({ type: "routineRuns", agentID, runs: runs.data })
}

export async function handleRoutineMessage(input: {
  message: Msg
  client: KiloClient | null
  directory: string
  post: (msg: unknown) => void
  track?: (sessionID: string) => void
}): Promise<boolean> {
  const type = input.message.type
  if (!owned(type)) return false
  if (!input.client) {
    input.post({ type: "routineState", error: "Raya is not connected." })
    return true
  }
  const ctx: Ctx = {
    message: input.message,
    kilo: input.client.kilocode.routine,
    dir: input.directory,
    post: input.post,
    track: input.track,
  }
  try {
    if (type === "routineList") {
      await list(ctx)
      return true
    }
    if (type === "routineCreate") {
      await create(ctx)
      return true
    }
    if (type === "routineUpdate") {
      await update(ctx)
      return true
    }
    if (type === "routineRemove") {
      await drop(ctx)
      return true
    }
    if (type === "routineRun") {
      await fire(ctx)
      return true
    }
    await one(ctx)
    return true
  } catch (err) {
    ctx.post({ type: "routineState", error: reason(err) })
    return true
  }
}

async function refresh(ctx: Ctx) {
  const agents = await ctx.kilo.list({ directory: ctx.dir }, { throwOnError: true })
  ctx.post({ type: "routineState", agents: agents.data, saved: true })
  await history(ctx.kilo, ctx.dir, ctx.post, (agents.data ?? []) as Listed[])
}
