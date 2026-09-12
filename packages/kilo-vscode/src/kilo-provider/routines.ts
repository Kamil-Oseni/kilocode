import { english } from "@opencode-ai/core/kilocode/schedule"
export { english } from "@opencode-ai/core/kilocode/schedule"
import type { KiloClient, KilocodeRoutineForecastResponse } from "@kilocode/sdk/v2/client"
import { mkdir } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { getErrorMessage } from "../kilo-provider-utils"
import { Edit, Proposal, Schedule } from "../shared/routine-schedule"
import { Output } from "../shared/routine-output"
import { recovery } from "../shared/routine-error"

type Msg = { type: string } & Record<string, unknown>
type Kilo = KiloClient["kilocode"]["routine"]
type Ctx = {
  message: Msg
  kilo: Kilo
  dir: string
  post: (msg: unknown) => void
  track?: (sessionID: string) => void
  refresh?: (requestID?: string, viewID?: string) => Promise<void>
}

type Listed = { id: string }
const previews = new Map<
  string,
  { kilo: Kilo; dir: string; data: KilocodeRoutineForecastResponse; expires: number; submitted?: boolean; edit?: Edit }
>()

function schedule(msg: Msg) {
  if (msg.schedule !== undefined) {
    const result = Schedule.safeParse(msg.schedule)
    if (!result.success) throw new Error("Choose a valid schedule and preview it again.")
    return result.data
  }
  const parsed =
    typeof msg.cron === "string"
      ? { kind: "cron" as const, expr: msg.cron }
      : english(typeof msg.when === "string" ? msg.when : undefined)
  if (parsed.kind !== "cron") return parsed
  const tz = typeof msg.tz === "string" ? msg.tz.trim() : undefined
  if (tz === "") throw new Error("Choose a timezone for this routine.")
  return { ...parsed, tz }
}

async function forecast(ctx: Ctx) {
  const id = ctx.message.requestID
  if (typeof id !== "string" || !id || id.length > 128) throw new Error("Request a new schedule preview.")
  const edit = ctx.message.edit === undefined ? undefined : Edit.safeParse(ctx.message.edit)
  if (edit && !edit.success) throw new Error("Reload the routine before previewing its schedule.")
  const proposal = ctx.message.schedule === undefined ? undefined : Proposal.safeParse(ctx.message.schedule)
  if (proposal && !proposal.success) throw new Error("Choose a valid schedule and preview it again.")
  const result = await ctx.kilo.forecast(
    { directory: ctx.dir, body: proposal?.data ?? schedule(ctx.message) },
    { throwOnError: true },
  )
  if (!result.data) throw new Error("No schedule preview was returned. Try again.")
  const token = crypto.randomUUID()
  previews.set(token, {
    kilo: ctx.kilo,
    dir: ctx.dir,
    data: result.data,
    expires: Date.now() + 600_000,
    edit: edit?.data,
  })
  while (previews.size > 32) {
    const oldest = previews.keys().next().value
    if (oldest) previews.delete(oldest)
  }
  ctx.post({ type: "routineForecast", requestID: id, forecastID: token, ...result.data })
}

function confirmed(ctx: Ctx) {
  if (ctx.message.forecastID === undefined) return schedule(ctx.message)
  const item = previews.get(String(ctx.message.forecastID))
  if (!item || item.kilo !== ctx.kilo || item.dir !== ctx.dir || item.expires <= Date.now())
    throw new Error("This schedule preview has expired. Preview it again before saving.")
  if (
    ctx.message.type === "routineScheduleUpdate" ? item.edit?.agentID !== ctx.message.agentID : item.edit !== undefined
  )
    throw new Error("This preview belongs to a different routine or action. Preview the schedule again.")
  if (item.submitted)
    throw new Error("This assignment was already submitted. Check the routine list before trying again.")
  if (item.data.schedule.kind === "once" && Number(item.data.schedule.at) <= Date.now())
    throw new Error("The previewed time has passed. Preview a new time before saving.")
  if (item.data.schedule.kind === "cron" && Number(item.data.occurrences[0]) <= Date.now())
    throw new Error("The first previewed time has passed. Preview the schedule again before saving.")
  return item.data.schedule
}

async function reschedule(ctx: Ctx) {
  const msg = ctx.message
  if (typeof msg.requestID !== "string" || !msg.requestID || typeof msg.forecastID !== "string")
    throw new Error("Preview the schedule before saving.")
  const schedule = confirmed(ctx)
  const item = previews.get(msg.forecastID)
  if (!item?.edit) throw new Error("Preview this routine's schedule before saving.")
  item.submitted = true
  await ctx.kilo.update({ directory: ctx.dir, ...item.edit, schedule }, { throwOnError: true })
  previews.delete(msg.forecastID)
  ctx.post({ type: "routineScheduleUpdated", requestID: msg.requestID, agentID: item.edit.agentID })
}

function reply(type: string) {
  if (type === "routineOutputUpdate") return "routineOutputUpdated"
  if (type === "routineAccessUpdate") return "routineAccessUpdated"
  if (type === "routineArchive") return "routineArchive"
  if (type === "routineSnapshot") return "routineSnapshot"
  if (type === "routineForecast") return "routineForecast"
  if (type === "routineScheduleUpdate") return "routineScheduleUpdated"
  if (type === "routineInboxPage") return "routineInboxPage"
  if (type === "routineInboxSend") return "routineInboxSent"
  if (type === "routineInboxInfo") return "routineInboxInfo"
  if (type === "routineInboxRead") return "routineInboxRead"
  if (type === "routineInboxDraft") return "routineInboxDraft"
  if (type === "routineDelegate") return "routineDelegated"
  if (type === "routineDelegateCancel") return "routineDelegateStopped"
  if (type === "routineDelegateChain") return "routineDelegateChain"
  return "routineState"
}

export function reason(err: unknown) {
  const text = getErrorMessage(err)
  if (
    text &&
    !/^(?:GET|POST|PUT|PATCH|DELETE) https?:/i.test(text) &&
    !["Bad Request", "{}", "undefined", "null", "[object Object]"].includes(text)
  )
    return text
  return "The routine request was not confirmed. Check its current state before trying again."
}

function owned(type: string) {
  return (
    type === "routineList" ||
    type === "routineOutputUpdate" ||
    type === "routineAccessUpdate" ||
    type === "routineForecast" ||
    type === "routineScheduleUpdate" ||
    type === "routineCreate" ||
    type === "routineUpdate" ||
    type === "routineRun" ||
    type === "routineRuns" ||
    type === "routineSnapshot" ||
    type === "routineArchive" ||
    type === "routineRemove" ||
    type === "routineInboxPage" ||
    type === "routineInboxSend" ||
    type === "routineInboxInfo" ||
    type === "routineInboxRead" ||
    type === "routineInboxDraft" ||
    type === "routineDelegate" ||
    type === "routineDelegateCancel" ||
    type === "routineDelegateChain"
  )
}

function mode(msg: Msg) {
  if (typeof msg.mode !== "string") return
  const name = msg.mode.trim()
  if (!name || name === "chat") return ""
  return name
}

function folder(msg: Msg) {
  const path = typeof msg.dir === "string" ? msg.dir.trim() : ""
  if (path) return path
}

function tools(msg: Msg) {
  if (!Array.isArray(msg.tools)) return
  return msg.tools.filter((item): item is string => typeof item === "string")
}

function capabilities(msg: Msg) {
  if (!Array.isArray(msg.capabilities)) return
  return msg.capabilities.filter((item): item is string => typeof item === "string")
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

function token(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
}

async function summaries(ctx: Ctx) {
  const listed = await ctx.kilo.inbox({ directory: ctx.dir }, { throwOnError: true }).catch((err: unknown) => {
    ctx.post({ type: "routineInbox", requestID: ctx.message.requestID, error: reason(err) })
    return undefined
  })
  if (!listed) return
  if (!Array.isArray(listed.data)) {
    ctx.post({
      type: "routineInbox",
      requestID: ctx.message.requestID,
      error: "The routine inbox could not be read.",
    })
    return
  }
  ctx.post({ type: "routineInbox", requestID: ctx.message.requestID, items: listed.data })
}

async function page(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID))
    throw new Error("Reload the routine conversation before reading it.")
  const cursor = msg.cursor === undefined ? undefined : String(msg.cursor)
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 256))
    throw new Error("This inbox page cursor is invalid.")
  const result = await ctx.kilo.inbox2.page(
    {
      directory: ctx.dir,
      agentID: String(msg.agentID),
      ...(cursor ? { cursor } : {}),
    },
    { throwOnError: true },
  )
  ctx.post({
    type: "routineInboxPage",
    requestID: msg.requestID,
    agentID: msg.agentID,
    messages: result.data?.messages,
    next: result.data?.next,
  })
}

async function send(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID) || !token(msg.source))
    throw new Error("Reload the conversation before sending again.")
  const text = typeof msg.body === "string" ? msg.body : ""
  if (!text.trim() || text.length > 8000) throw new Error("Write a follow-up before sending.")
  const result = await ctx.kilo.inbox2.send(
    { directory: ctx.dir, agentID: String(msg.agentID), source: String(msg.source), body: text },
    { throwOnError: true },
  )
  ctx.post({ type: "routineInboxSent", requestID: msg.requestID, agentID: msg.agentID, message: result.data })
}

async function info(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID) || (msg.section !== "shares" && msg.section !== "contacts"))
    throw new Error("Reload the conversation before opening its info.")
  const cursor = msg.cursor === undefined ? undefined : String(msg.cursor)
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 256))
    throw new Error("This chat info page cursor is invalid.")
  const result = await ctx.kilo.inbox2.info(
    {
      directory: ctx.dir,
      agentID: String(msg.agentID),
      section: msg.section,
      ...(cursor ? { cursor } : {}),
    },
    { throwOnError: true },
  )
  if (!result.data || result.data.section !== msg.section)
    throw new Error("The routine chat info response did not match this request.")
  ctx.post({
    type: "routineInboxInfo",
    requestID: msg.requestID,
    agentID: msg.agentID,
    section: msg.section,
    items: result.data.items,
    next: result.data.next,
  })
}

async function seen(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID) || !Number.isSafeInteger(msg.at) || Number(msg.at) < 0)
    throw new Error("Reload the conversation before marking it read.")
  const result = await ctx.kilo.inbox2.read(
    { directory: ctx.dir, agentID: String(msg.agentID), at: Number(msg.at) },
    { throwOnError: true },
  )
  ctx.post({ type: "routineInboxRead", requestID: msg.requestID, agentID: msg.agentID, at: result.data?.at })
}

async function scribble(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID)) throw new Error("Reload the conversation before saving a draft.")
  const draft = msg.draft === null || msg.draft === undefined ? null : String(msg.draft)
  if (draft !== null && draft.length > 8000) throw new Error("Inbox drafts are limited to 8000 characters.")
  const result = await ctx.kilo.inbox2.draft(
    { directory: ctx.dir, agentID: String(msg.agentID), draft: draft ?? "" },
    { throwOnError: true },
  )
  ctx.post({
    type: "routineInboxDraft",
    requestID: msg.requestID,
    agentID: msg.agentID,
    draft: result.data?.draft ?? null,
  })
}

async function pass(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID) || !token(msg.source) || !token(msg.recipientID))
    throw new Error("Reload the conversation before asking another worker.")
  const text = typeof msg.objective === "string" ? msg.objective : ""
  if (!text.trim() || text.length > 8000) throw new Error("Write what the other worker should answer.")
  const result = await ctx.kilo.delegate
    .create(
      {
        directory: ctx.dir,
        agentID: String(msg.agentID),
        source: String(msg.source),
        senderID: String(msg.agentID),
        recipientID: String(msg.recipientID),
        objective: text,
        ...(token(msg.parentRunID) ? { parentRunID: String(msg.parentRunID) } : {}),
      },
      { throwOnError: true },
    )
    .catch((err: unknown) => {
      const text = getErrorMessage(err)
      if (/\b404\b|not found/i.test(text))
        throw new Error("This worker is no longer available. Delegation is not started.")
      throw err
    })
  ctx.post({ type: "routineDelegated", requestID: msg.requestID, agentID: msg.agentID, record: result.data })
  await summaries(ctx)
}

async function halt(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID) || !token(msg.id))
    throw new Error("Reload the conversation before stopping that request.")
  const result = await ctx.kilo.delegate.cancel(
    { directory: ctx.dir, agentID: String(msg.agentID), id: String(msg.id) },
    { throwOnError: true },
  )
  ctx.post({ type: "routineDelegateStopped", requestID: msg.requestID, agentID: msg.agentID, record: result.data })
  await summaries(ctx)
}

async function trace(ctx: Ctx) {
  const msg = ctx.message
  if (!token(msg.requestID) || !token(msg.agentID) || !token(msg.id))
    throw new Error("Reload the conversation before inspecting that request.")
  const result = await ctx.kilo.delegate.chain(
    { directory: ctx.dir, agentID: String(msg.agentID), id: String(msg.id) },
    { throwOnError: true },
  )
  ctx.post({
    type: "routineDelegateChain",
    requestID: msg.requestID,
    agentID: msg.agentID,
    id: msg.id,
    record: result.data?.record,
    above: result.data?.above,
    below: result.data?.below,
  })
}

async function list(ctx: Ctx) {
  if (ctx.refresh)
    return ctx.refresh(
      typeof ctx.message.requestID === "string" ? ctx.message.requestID : undefined,
      typeof ctx.message.viewID === "string" ? ctx.message.viewID : undefined,
    )
  const [agents, templates] = await Promise.all([
    ctx.kilo.list({ directory: ctx.dir }, { throwOnError: true }),
    ctx.kilo.templates({ directory: ctx.dir }, { throwOnError: true }),
  ])
  ctx.post({ type: "routineState", requestID: ctx.message.requestID, agents: agents.data, templates: templates.data })
  await summaries(ctx)
  await history(ctx.kilo, ctx.dir, ctx.post, (agents.data ?? []) as Listed[])
}

async function create(ctx: Ctx) {
  const msg = ctx.message
  confirmed(ctx)
  const parsed = msg.output === undefined ? undefined : Output.safeParse(msg.output)
  if (parsed && !parsed.success)
    throw new Error("Describe the required output and provide 1–20 distinct criteria with verification instructions.")
  const output = parsed?.data
  const capabilities = Array.isArray(msg.capabilities)
    ? msg.capabilities.filter((item): item is string => typeof item === "string")
    : undefined
  const dir = folder(msg)
  if (dir) await mkdir(dir, { recursive: true })
  const schedule = confirmed(ctx)
  const preview = previews.get(String(msg.forecastID))
  if (preview) preview.submitted = true
  const created = await ctx.kilo.create(
    {
      directory: ctx.dir,
      name: typeof msg.name === "string" ? msg.name : undefined,
      role: typeof msg.role === "string" ? msg.role : undefined,
      objective: typeof msg.objective === "string" ? msg.objective : undefined,
      output,
      capabilities,
      schedule,
      enabled: msg.enabled !== false,
      plan: typeof msg.plan === "string" ? msg.plan : undefined,
      mode: mode(msg),
      dir: folder(msg),
      access: access(msg),
      tools: tools(msg),
    },
    { throwOnError: true },
  )
  const id = created.data?.id
  if (typeof msg.forecastID === "string") previews.delete(msg.forecastID)
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
      mode: mode(msg),
      dir: folder(msg),
      access: access(msg),
      tools: tools(msg),
      capabilities: capabilities(msg),
    },
    { throwOnError: true },
  )
  await refresh(ctx)
}

async function review(ctx: Ctx) {
  const msg = ctx.message
  if (
    typeof msg.requestID !== "string" ||
    !msg.requestID ||
    msg.requestID.length > 128 ||
    typeof msg.agentID !== "string" ||
    !msg.agentID ||
    msg.agentID.length > 256 ||
    (msg.access !== "brief" && msg.access !== "full") ||
    (msg.expectedAccess !== "unset" && msg.expectedAccess !== "brief" && msg.expectedAccess !== "full")
  )
    throw new Error("Reload the routine before reviewing access.")
  const result = await ctx.kilo.update(
    {
      directory: ctx.dir,
      agentID: msg.agentID,
      access: msg.access,
      expectedAccess: msg.expectedAccess,
    },
    { throwOnError: true },
  )
  if (result.data?.id !== msg.agentID || result.data.access !== msg.access)
    throw new Error("The saved access could not be confirmed. Reload the routine before trying again.")
  ctx.post({ type: "routineAccessUpdated", requestID: msg.requestID, agentID: msg.agentID, access: result.data.access })
}

async function output(ctx: Ctx) {
  const msg = ctx.message
  if ([msg.requestID, msg.agentID].some((id) => typeof id !== "string" || !id || id.length > 256))
    throw new Error("Reload the routine before editing its output requirements.")
  const contract = Output.safeParse(msg.output)
  const expected = msg.expectedOutput === "unset" ? "unset" : Output.safeParse(msg.expectedOutput)
  if (!contract.success || (expected !== "unset" && !expected.success))
    throw new Error("Provide valid output requirements and reload the saved version before editing.")
  const result = await ctx.kilo.update(
    {
      directory: ctx.dir,
      agentID: String(msg.agentID),
      output: contract.data,
      expectedOutput: expected === "unset" ? expected : expected.data,
    },
    { throwOnError: true },
  )
  if (result.data?.id !== msg.agentID || !isDeepStrictEqual(result.data.output, contract.data))
    throw new Error("The saved output requirements could not be confirmed. Close and reload the routine.")
  ctx.post({ type: "routineOutputUpdated", requestID: msg.requestID, agentID: msg.agentID, output: result.data.output })
}

async function drop(ctx: Ctx) {
  const ids = Array.isArray(ctx.message.agentIDs)
    ? ctx.message.agentIDs.filter((item): item is string => typeof item === "string")
    : [String(ctx.message.agentID)]
  for (const id of ids) {
    if (!id || id === "undefined") continue
    await ctx.kilo.remove({ directory: ctx.dir, agentID: id }, { throwOnError: true })
  }
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

async function snapshot(ctx: Ctx) {
  const msg = ctx.message
  if ([msg.agentID, msg.runID, msg.requestID].some((id) => typeof id !== "string" || !id || id.length > 256))
    throw new Error("Select a saved run and try again.")
  const result = await ctx.kilo.snapshot(
    { directory: ctx.dir, agentID: String(msg.agentID), runID: String(msg.runID) },
    { throwOnError: false },
  )
  const base = { type: "routineSnapshot", agentID: msg.agentID, runID: msg.runID, requestID: msg.requestID }
  if (result.response.status === 404) {
    ctx.post({ ...base, missing: true })
    return
  }
  if (!result.data || result.error) throw new Error("The saved instructions could not be read. Try again.")
  if (
    result.data.agentID !== msg.agentID ||
    result.data.runID !== msg.runID ||
    result.data.definition.id !== msg.agentID
  )
    throw new Error("The saved instructions do not match this run.")
  ctx.post({ ...base, snapshot: result.data })
}

async function retained(ctx: Ctx, id: string) {
  const runs = await ctx.kilo.runs({ directory: ctx.dir, agentID: id }, { throwOnError: true })
  if (
    !runs.data ||
    runs.data.some((run) => run.agentID !== id || typeof run.at !== "number" || !Number.isFinite(run.at))
  )
    throw new Error("The retained runs could not be verified for this routine.")
  const inbox = await ctx.kilo.inbox2.page({ directory: ctx.dir, agentID: id }, { throwOnError: true })
  if (!inbox.data?.messages || inbox.data.messages.some((item) => item.agentID !== id))
    throw new Error("The retained conversation could not be verified for this routine.")
  return { runs: runs.data, messages: inbox.data.messages }
}

async function archive(ctx: Ctx) {
  const msg = ctx.message
  if (typeof msg.requestID !== "string" || !msg.requestID || msg.requestID.length > 256)
    throw new Error("Reload the routine archive.")
  if (msg.agentID !== undefined && (typeof msg.agentID !== "string" || !msg.agentID || msg.agentID.length > 256))
    throw new Error("Select a removed routine.")
  if (
    msg.cursor !== undefined &&
    (typeof msg.cursor !== "string" || !msg.cursor || msg.cursor.length > 256 || msg.agentID !== undefined)
  )
    throw new Error("Refresh the routine archive before loading another page.")
  const result = await ctx.kilo.archive(
    { directory: ctx.dir, agentID: msg.agentID, cursor: msg.cursor },
    { throwOnError: true },
  )
  if (!result.data) throw new Error("The routine archive could not be read.")
  const base = { type: "routineArchive", requestID: msg.requestID, agentID: msg.agentID }
  if (msg.agentID === undefined) {
    ctx.post({ ...base, archive: result.data.items, next: result.data.next })
    return
  }
  if (!result.data.items.some((item) => item.definition.id === msg.agentID))
    throw new Error("This routine is no longer in the archive. Refresh the list.")
  ctx.post({ ...base, ...(await retained(ctx, String(msg.agentID))) })
}

const routes: Record<string, (ctx: Ctx) => Promise<void>> = {
  routineOutputUpdate: output,
  routineAccessUpdate: review,
  routineArchive: archive,
  routineSnapshot: snapshot,
  routineScheduleUpdate: reschedule,
  routineForecast: forecast,
  routineInboxPage: page,
  routineInboxSend: send,
  routineInboxInfo: info,
  routineInboxRead: seen,
  routineInboxDraft: scribble,
  routineDelegate: pass,
  routineDelegateCancel: halt,
  routineDelegateChain: trace,
  routineList: list,
  routineCreate: create,
  routineUpdate: update,
  routineRemove: drop,
  routineRun: fire,
}

export async function handleRoutineMessage(input: {
  message: Msg
  client: KiloClient | null
  directory: string
  post: (msg: unknown) => void
  track?: (sessionID: string) => void
  refresh?: (requestID?: string, viewID?: string) => Promise<void>
}): Promise<boolean> {
  const type = input.message.type
  if (!owned(type)) return false
  if (type === "routineList" && input.refresh) {
    await input.refresh(
      typeof input.message.requestID === "string" ? input.message.requestID : undefined,
      typeof input.message.viewID === "string" ? input.message.viewID : undefined,
    )
    return true
  }
  if (!input.client) {
    input.post({
      type: reply(type),
      requestID: input.message.requestID,
      agentID: input.message.agentID,
      runID: input.message.runID,
      section: input.message.section,
      error: "Raya is not connected.",
    })
    return true
  }
  const ctx: Ctx = {
    message: input.message,
    kilo: input.client.kilocode.routine,
    dir: input.directory,
    post: input.post,
    track: input.track,
    refresh: input.refresh,
  }
  try {
    await (routes[type] ?? one)(ctx)
    return true
  } catch (err) {
    ctx.post({
      type: reply(type),
      requestID: ctx.message.requestID,
      agentID: ctx.message.agentID,
      runID: ctx.message.runID,
      section: ctx.message.section,
      error: reason(err),
      recovery: recovery(err),
    })
    return true
  }
}

async function refresh(ctx: Ctx) {
  if (ctx.refresh) {
    ctx.post({ type: "routineState", saved: true })
    await ctx.refresh()
    return
  }
  const agents = await ctx.kilo.list({ directory: ctx.dir }, { throwOnError: true })
  ctx.post({ type: "routineState", agents: agents.data, saved: true })
  await summaries(ctx)
  await history(ctx.kilo, ctx.dir, ctx.post, (agents.data ?? []) as Listed[])
}
