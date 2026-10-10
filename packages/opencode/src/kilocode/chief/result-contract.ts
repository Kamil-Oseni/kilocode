import { Effect, Schema } from "effect"
import { z } from "zod"
import { digest as evidence } from "@opencode-ai/core/kilocode/evidence-digest"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { BackgroundJob } from "@/background/job"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { RayaChief } from "."
import { TaskName } from "../tool/task-name"
import { resumeHint } from "../task-resume"

const proof = z
  .object({
    version: z.literal(1),
    kind: z.enum(["narrative", "directory_entries"]),
    sessionID: z.string().min(1).max(256),
    userID: z.string().min(1).max(256),
    request: z.string().min(1).max(65536),
    decisionSHA: z.string().regex(/^[a-f0-9]{64}$/),
    route: z
      .object({
        messageID: z.string().min(1).max(256),
        partID: z.string().min(1).max(256),
        callID: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict()
const invocation = z
  .object({
    sessionID: z.string().min(1).max(256),
    inputID: z.string().min(1).max(256),
    parentMessageID: z.string().min(1).max(256),
    callID: z.string().min(1).max(256),
  })
  .strict()
const inherited = proof
  .extend({ task: invocation, origin: invocation, continuations: z.array(invocation).max(16) })
  .strict()

type Sessions = Pick<Session.Interface, "get" | "messages">
type Dispatch = { sessionID: SessionID; userID: string; messageID: string }
const held = new WeakMap<
  object,
  {
    sessions: Sessions
    selected: SessionID | Dispatch
    sha: string
    authority: string
    inputID: string
    currentID: string
    inputs: readonly string[]
    saved?: z.infer<typeof inherited>
  }
>()
const digest = (value: unknown) => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 128 * 1024)
    throw new Error("Result contract evidence exceeded bound")
  return evidence({ tool: "chief-result-contract", state: value })
}
const snapshot = digest
const window = (rows: readonly SessionV1.WithParts[], anchor: string) => {
  const current = rows.filter((row) => row.info.id >= anchor)
  if (
    !current.some((row) => row.info.id === anchor && row.info.role === "user") ||
    current.length > 128 ||
    new Set(current.map((row) => row.info.id)).size !== current.length ||
    current.some((row) => row.parts.length > 256)
  )
    throw new Error("Result contract history exceeded bound or original input is absent")
  return current
}
const core = (value: z.infer<typeof inherited>) =>
  proof.parse({
    version: value.version,
    kind: value.kind,
    sessionID: value.sessionID,
    userID: value.userID,
    request: value.request,
    decisionSHA: value.decisionSHA,
    route: value.route,
  })

type Notice = {
  sessions: Sessions
  background: Pick<BackgroundJob.Interface, "get">
  review: z.infer<typeof proof>
  authority: string
  jobID: string
  jobSHA: string
  text: string
  current: string
  prepared?: string
  row?: string
}
const grants = new WeakMap<object, Notice>()
const notices = new WeakMap<Sessions, Map<string, Notice>>()
const freshNotice = Effect.fn("ResultContract.freshNotice")(function* (notice: Notice) {
  const job = yield* notice.background.get(notice.jobID)
  if (!job || snapshot(job) !== notice.jobSHA) throw new Error("Result contract background completion changed")
})
const continuation = Effect.fn("ResultContract.continuation")(function* (sessions: Sessions, row: SessionV1.WithParts) {
  const notice = notices.get(sessions)?.get(row.info.id)
  if (!notice || notice.row !== snapshot(row) || row.info.sessionID !== notice.review.sessionID)
    throw new Error("Result contract synthetic continuation is unauthenticated")
  yield* freshNotice(notice)
})

/** A request result contract selects rendering only; it never grants tool or native authority. */
export namespace ResultContract {
  export const key = "raya.chief.result-contract"
  export const unavailable = "Directory result contract lacks completed Read evidence"

  export type Review = Readonly<z.infer<typeof proof>>

  const original = Effect.fn("ResultContract.original")(function* (
    sessions: Sessions,
    input: SessionID | Dispatch,
    pending?: SessionV1.WithParts,
  ) {
    const selected = typeof input === "string" ? input : input.sessionID
    const session = yield* sessions.get(selected)
    if (session.parentID) throw new Error("Result contract root is not original")
    const log = session.metadata?.[RayaChief.logKey]
    const latest = Array.isArray(log) ? log.at(-1) : undefined
    if (
      latest &&
      typeof latest === "object" &&
      "result" in latest &&
      latest.result !== undefined &&
      !Schema.is(RayaChief.Decision)(latest)
    )
      throw new Error("Result contract saved decision is unreadable")
    const decision = RayaChief.history(session.metadata).at(-1)
    if (!decision || decision.result === undefined) return undefined
    const fetched = yield* sessions.messages({ sessionID: selected, limit: 129 })
    const user = fetched.findLast((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts))
    if (
      user?.info.role === "user" &&
      decision.userID !== user.info.id &&
      (RayaChief.phase(session.metadata) === "route" || user.info.agent !== "auto")
    )
      return undefined
    const rows = window(fetched, decision.userID)
    if (
      user?.info.role !== "user" ||
      user.info.sessionID !== selected ||
      user.info.agent !== "auto" ||
      decision.userID !== user.info.id ||
      RayaChief.requestText(user.parts) !== decision.request ||
      RayaChief.request(session.metadata) !== decision.request ||
      (decision.result === "directory_entries" && (decision.access !== "read" || decision.direct === true))
    )
      throw new Error("Result contract current request differs")
    for (const row of rows) {
      if (row.info.role !== "user" || row.info.id <= user.info.id) continue
      if (pending && row.info.id === pending.info.id && snapshot(row) === snapshot(pending)) continue
      yield* continuation(sessions, row)
    }
    const calls = rows.flatMap((row) =>
      row.parts.flatMap((part) => {
        if (
          part.type !== "tool" ||
          part.tool !== "chief_route" ||
          part.state.status !== "completed" ||
          row.info.role !== "assistant" ||
          row.info.agent !== "auto" ||
          row.info.sessionID !== selected ||
          row.info.parentID !== user.info.id ||
          row.info.error ||
          part.sessionID !== selected ||
          part.messageID !== row.info.id ||
          part.state.input.result !== decision.result ||
          part.state.input.access !== decision.access ||
          !part.callID ||
          !Number.isSafeInteger(part.state.time.start) ||
          !Number.isSafeInteger(part.state.time.end) ||
          part.state.time.end < part.state.time.start ||
          part.state.time.start < user.info.time.created ||
          part.state.output !== JSON.stringify(decision)
        )
          return []
        return [
          {
            messageID: row.info.id,
            partID: part.id,
            callID: part.callID,
            input: part.state.input,
            output: part.state.output,
          },
        ]
      }),
    )
    if (calls.length !== 1) throw new Error("Result contract completed Chief dispatch is unavailable")
    const parsed = proof.parse({
      version: 1,
      kind: decision.result,
      sessionID: selected,
      userID: user.info.id,
      request: decision.request,
      decisionSHA: digest(decision),
      route: { messageID: calls[0].messageID, partID: calls[0].partID, callID: calls[0].callID },
    })
    const value: Review = Object.freeze({ ...parsed, route: Object.freeze(parsed.route) })
    held.set(value, {
      sessions,
      selected: typeof input === "string" ? input : Object.freeze({ ...input }),
      sha: digest(value),
      authority: snapshot({ call: calls[0], user }),
      inputID: user.info.id,
      currentID: rows.findLast((row) => row.info.role === "user")!.info.id,
      inputs: rows.filter((row) => row.info.role === "user" && row.info.id >= user.info.id).map((row) => row.info.id),
    })
    return value
  })

  export const load = Effect.fn("ResultContract.load")(function* (sessions: Sessions, input: SessionID | Dispatch) {
    const selected = typeof input === "string" ? input : input.sessionID
    const session = yield* sessions.get(selected)
    const dispatch = typeof input === "string" ? undefined : input
    if (dispatch) {
      const rows = yield* sessions.messages({ sessionID: selected, limit: 129 })
      const user = rows.findLast((row) => row.info.role === "user")
      const row = rows.find((row) => row.info.id === dispatch.messageID)
      if (!session.parentID && user && !RayaChief.requestText(user.parts)) yield* continuation(sessions, user)
      if (
        rows.some(
          (item) =>
            item.info.role === "assistant" &&
            item.info.parentID === dispatch.userID &&
            item.info.id > dispatch.messageID,
        ) ||
        user?.info.id !== dispatch.userID ||
        row?.info.role !== "assistant" ||
        row.info.parentID !== dispatch.userID ||
        row.info.sessionID !== selected ||
        row.info.error
      )
        throw new Error("Result contract current dispatch differs")
    }
    if (session.parentID) {
      const raw = session.metadata?.[key]
      if (raw === undefined) return undefined
      const saved = inherited.parse(raw)
      if (saved.sessionID !== session.parentID) throw new Error("Result contract parent differs")
      const owner = TaskName.read(session.metadata?.[TaskName.key])
      if (
        !owner ||
        owner.provenance.parentSessionID !== session.parentID ||
        owner.provenance.parentMessageID !== saved.origin.parentMessageID ||
        owner.provenance.callID !== saved.origin.callID
      )
        throw new Error("Result contract child invocation differs")
      const parent = yield* original(sessions, session.parentID)
      if (!parent || digest(parent) !== digest(core(saved))) throw new Error("Result contract original changed")
      const rows = window(yield* sessions.messages({ sessionID: session.parentID, limit: 129 }), saved.userID)
      const chain = [...saved.continuations, saved.task]
      if (
        digest(chain[0]) !== digest(saved.origin) ||
        new Set(chain.map((item) => item.callID)).size !== chain.length ||
        new Set(chain.map((item) => item.inputID)).size !== chain.length
      )
        throw new Error("Result contract resume chain differs")
      const children = window(yield* sessions.messages({ sessionID: selected, limit: 129 }), saved.origin.inputID)
      if (children.findLast((row) => row.info.role === "user")?.info.id !== saved.task.inputID)
        throw new Error("Result contract child input differs")
      const inputs: unknown[] = []
      for (const [index, task] of chain.entries()) {
        const row = rows.find((row) => row.info.id === task.parentMessageID)
        const calls =
          row?.parts.filter((part) => part.type === "tool" && part.tool === "task" && part.callID === task.callID) ?? []
        const call = calls[0]
        if (call?.type !== "tool" || call.state.status === "pending")
          throw new Error("Result contract original Task is unavailable")
        if (row?.info.role === "assistant" && row.info.parentID !== saved.userID) {
          const id = row.info.parentID
          const parent = rows.find((item) => item.info.id === id)
          if (parent?.info.role !== "user") throw new Error("Result contract parent continuation differs")
          yield* continuation(sessions, parent)
          if (digest(notices.get(sessions)?.get(parent.info.id)?.review) !== digest(core(saved)))
            throw new Error("Result contract parent continuation differs")
        }
        const user = children.find((row) => row.info.id === task.inputID)
        const terminal = children.findLast((row) => row.info.role === "assistant" && row.info.parentID === task.inputID)
        const failed =
          call?.type === "tool" &&
          call.state.status === "error" &&
          call.state.error === `${unavailable}\n${resumeHint(selected)}` &&
          Number.isSafeInteger(call.state.time.end) &&
          terminal?.info.role === "assistant" &&
          Number.isSafeInteger(terminal.info.time.completed) &&
          z
            .object({ name: z.literal("UnknownError"), data: z.object({ message: z.literal(unavailable) }).strict() })
            .strict()
            .safeParse(terminal.info.error).success
        if (
          task.sessionID !== selected ||
          user?.info.role !== "user" ||
          user.info.sessionID !== selected ||
          row?.info.role !== "assistant" ||
          row.info.sessionID !== session.parentID ||
          row.info.error ||
          calls.length !== 1 ||
          call?.type !== "tool" ||
          call.sessionID !== session.parentID ||
          call.messageID !== row.info.id ||
          (call.state.status !== "running" && call.state.status !== "completed" && !failed) ||
          (index < chain.length - 1 && call.state.status !== "completed" && !failed) ||
          call.state.metadata?.sessionId !== selected ||
          call.state.metadata?.childMessageID !== task.inputID ||
          (index > 0 &&
            (task.inputID <= chain[index - 1].inputID || task.parentMessageID <= chain[index - 1].parentMessageID))
        )
          throw new Error("Result contract original Task is unavailable")
        inputs.push({ input: call.state.input, user: snapshot(user) })
      }
      const parsed = core(saved)
      const value: Review = Object.freeze({ ...parsed, route: Object.freeze(parsed.route) })
      held.set(value, {
        sessions,
        selected: typeof input === "string" ? input : Object.freeze({ ...input }),
        sha: digest(value),
        authority: digest({ saved, owner, inputs, parent: held.get(parent)?.authority }),
        inputID: saved.task.inputID,
        currentID: saved.task.inputID,
        inputs: [saved.task.inputID],
        saved: structuredClone(saved),
      })
      return value
    }
    return yield* original(sessions, input)
  })

  export const check = Effect.fn("ResultContract.check")(function* (sessions: Sessions, value: Review) {
    const state = held.get(value)
    if (!state || state.sessions !== sessions || digest(value) !== state.sha)
      throw new Error("Result contract private binding differs")
    const current = yield* load(sessions, state.selected)
    if (!current || digest(current) !== state.sha || held.get(current)?.authority !== state.authority)
      throw new Error("Result contract current binding changed")
  })

  export function context(value: Review) {
    const state = held.get(value)
    if (!state || digest(value) !== state.sha) throw new Error("Result contract private binding differs")
    return Object.freeze({
      selected: typeof state.selected === "string" ? state.selected : state.selected.sessionID,
      input: MessageID.make(state.inputID),
      current: MessageID.make(state.currentID),
      inputs: Object.freeze(state.inputs.map((id) => MessageID.make(id))),
      ...(state.saved ? { task: Object.freeze({ ...state.saved.task }) } : {}),
    })
  }

  /** Expose recovery only for an exact retained no-evidence failure; this never authorizes an effect. */
  export const recovery = Effect.fn("ResultContract.recovery")(function* (
    sessions: Sessions,
    sessionID: SessionID,
    childID?: SessionID,
  ) {
    const session = yield* sessions.get(sessionID)
    if (session.parentID) return false
    const value = yield* load(sessions, sessionID)
    if (!value || value.kind !== "directory_entries") return false
    const rows = window(yield* sessions.messages({ sessionID, limit: 129 }), value.userID)
    const calls = rows.flatMap((row) =>
      row.parts.filter(
        (part) =>
          row.info.role === "assistant" &&
          !row.info.error &&
          context(value).inputs.includes(row.info.parentID) &&
          part.type === "tool" &&
          part.tool === "task" &&
          part.state.status === "error" &&
          typeof part.state.metadata?.sessionId === "string" &&
          part.state.error === `${unavailable}\n${resumeHint(part.state.metadata.sessionId)}`,
      ),
    )
    if (calls.length > 16) throw new Error("Result contract recovery exceeded bound")
    for (const call of calls) {
      if (call.type !== "tool" || call.state.status !== "error") continue
      const id = call.state.metadata?.sessionId
      const input = call.state.metadata?.childMessageID
      if (typeof id !== "string" || typeof input !== "string") continue
      if (childID !== undefined && id !== childID) continue
      const child = yield* load(sessions, SessionID.make(id))
      const saved = child && held.get(child)?.saved
      if (
        !child ||
        !saved ||
        digest(child) !== digest(value) ||
        saved.task.parentMessageID !== call.messageID ||
        saved.task.callID !== call.callID ||
        saved.task.inputID !== input
      )
        continue
      const children = window(
        yield* sessions.messages({ sessionID: SessionID.make(id), limit: 129 }),
        saved.origin.inputID,
      )
      const terminal = children.findLast((row) => row.info.role === "assistant" && row.info.parentID === input)
      if (
        terminal?.info.role !== "assistant" ||
        !Number.isSafeInteger(terminal.info.time.completed) ||
        !z
          .object({
            name: z.literal("UnknownError"),
            data: z.object({ message: z.literal(unavailable) }).strict(),
          })
          .strict()
          .safeParse(terminal.info.error).success
      )
        continue
      const retained = snapshot({ call, terminal })
      yield* check(sessions, value)
      yield* check(sessions, child)
      const current = window(yield* sessions.messages({ sessionID, limit: 129 }), value.userID)
      const fresh = window(
        yield* sessions.messages({ sessionID: SessionID.make(id), limit: 129 }),
        saved.origin.inputID,
      )
      if (
        snapshot({
          call: current.flatMap((row) => row.parts).find((part) => part.id === call.id),
          terminal: fresh.findLast((row) => row.info.role === "assistant" && row.info.parentID === input),
        }) !== retained
      )
        throw new Error("Result contract recovery changed")
      yield* check(sessions, value)
      return true
    }
    return false
  })

  /** Yield a simple directory request to its actual background notice, without inferring a result or settling work. */
  export const park = Effect.fn("ResultContract.park")(function* (
    sessions: Sessions,
    jobs: Pick<BackgroundJob.Interface, "get">,
    sessionID: SessionID,
    messageID: MessageID,
  ) {
    const session = yield* sessions.get(sessionID)
    if (session.parentID) return false
    const fetched = yield* sessions.messages({ sessionID, limit: 129 })
    const row = fetched.find((row) => row.info.id === messageID)
    if (
      row?.info.role !== "assistant" ||
      row.info.agent !== "auto" ||
      row.info.finish !== "tool-calls" ||
      row.info.error
    )
      return false
    const value = yield* load(sessions, { sessionID, messageID, userID: row.info.parentID })
    if (!value || value.kind !== "directory_entries") return false
    const decision = RayaChief.history(session.metadata).at(-1)
    if (!decision || decision.needs_plan) return false
    const rows = window(fetched, value.userID)
    if (
      rows.some((row) =>
        row.parts.some(
          (part) =>
            part.type === "tool" &&
            ((part.tool === "chief_plan" && part.state.status === "completed") ||
              (part.tool === "task" && typeof part.state.input.branch_id === "string")),
        ),
      )
    )
      return false
    const calls = row.parts.filter(
      (part) =>
        part.type === "tool" &&
        part.tool === "task" &&
        part.state.status === "completed" &&
        part.state.input.background === true &&
        part.state.metadata.background === true,
    )
    if (!calls.length) return false
    if (calls.length > 16) throw new Error("Result contract background park exceeded bound")
    const retained = snapshot(row)
    const originals: { id: string; sha: string; child: string; contract: string }[] = []
    for (const call of calls) {
      if (call.type !== "tool" || call.state.status !== "completed")
        throw new Error("Result contract background Task changed")
      const id = call.state.metadata.jobId
      const input = call.state.metadata.childMessageID
      if (
        typeof id !== "string" ||
        typeof input !== "string" ||
        call.state.metadata.sessionId !== id ||
        call.sessionID !== sessionID ||
        call.messageID !== messageID
      )
        throw new Error("Result contract original background Task differs")
      const job = yield* jobs.get(id)
      if (!job || job.status === "cancelled") return false
      if (!job.revision || job.origins?.length !== 1) throw new Error("Result contract background owner differs")
      const origin = job.origins[0]
      if (
        origin?.sessionID !== sessionID ||
        origin.messageID !== messageID ||
        origin.callID !== call.callID ||
        origin.childSessionID !== id ||
        origin.childMessageID !== input
      )
        throw new Error("Result contract background owner differs")
      const child = yield* sessions.get(SessionID.make(id))
      const saved = inherited.parse(child.metadata?.[key])
      if (
        child.parentID !== sessionID ||
        digest(core(saved)) !== digest(value) ||
        saved.task.sessionID !== id ||
        saved.task.inputID !== input ||
        saved.task.parentMessageID !== messageID ||
        saved.task.callID !== call.callID
      )
        throw new Error("Result contract background child differs")
      originals.push({
        id,
        sha: snapshot({ id: job.id, type: job.type, revision: job.revision, origins: job.origins }),
        child: id,
        contract: snapshot(saved),
      })
    }
    yield* check(sessions, value)
    const current = yield* sessions.messages({ sessionID, limit: 129 })
    if (snapshot(current.find((row) => row.info.id === messageID)) !== retained)
      throw new Error("Result contract background Task changed")
    for (const original of originals) {
      const job = yield* jobs.get(original.id)
      if (
        !job ||
        job.status === "cancelled" ||
        snapshot({ id: job.id, type: job.type, revision: job.revision, origins: job.origins }) !== original.sha
      )
        throw new Error("Result contract background owner changed")
      const child = yield* sessions.get(SessionID.make(original.child))
      if (child.parentID !== sessionID || snapshot(inherited.parse(child.metadata?.[key])) !== original.contract)
        throw new Error("Result contract background child changed")
    }
    yield* check(sessions, value)
    return true
  })

  /** Only the actual BackgroundJob service outcome can register an in-process continuation. */
  export const notice = Effect.fn("ResultContract.notice")(function* (
    sessions: Sessions,
    background: Pick<BackgroundJob.Interface, "get">,
    value: Review,
    jobID: string,
    text: string,
  ) {
    yield* check(sessions, value)
    const state = held.get(value)
    if (!state || context(value).selected !== value.sessionID || Buffer.byteLength(text, "utf8") > 64 * 1024)
      throw new Error("Result contract notice binding differs")
    const root = yield* original(sessions, SessionID.make(value.sessionID))
    if (!root || digest(root) !== digest(value) || held.get(root)?.authority !== state.authority)
      throw new Error("Result contract notice request changed")
    const job = yield* background.get(jobID)
    if (
      !job ||
      (job.status !== "completed" && job.status !== "error") ||
      !job.revision ||
      !Number.isSafeInteger(job.completed_at) ||
      job.origins?.length !== 1
    )
      throw new Error("Result contract original background completion is unavailable")
    const origin = job.origins[0]
    if (
      !origin ||
      origin.sessionID !== value.sessionID ||
      origin.childSessionID !== jobID ||
      !origin.childMessageID ||
      !origin.callID
    )
      throw new Error("Result contract background owner differs")
    const identity: string[] = []
    const terminal: boolean[] = []
    for (let attempt = 0; attempt <= 100; attempt++) {
      yield* check(sessions, value)
      const observed = yield* background.get(jobID)
      if (!observed || snapshot(observed) !== snapshot(job))
        throw new Error("Result contract background completion changed")
      const rows = window(
        yield* sessions.messages({ sessionID: SessionID.make(value.sessionID), limit: 129 }),
        value.userID,
      )
      const row = rows.find((row) => row.info.id === origin.messageID)
      const calls =
        row?.parts.filter((part) => part.type === "tool" && part.tool === "task" && part.callID === origin.callID) ?? []
      const call = calls[0]
      if (
        row?.info.role !== "assistant" ||
        !context(root).inputs.includes(row.info.parentID) ||
        row.info.error ||
        calls.length !== 1 ||
        call?.type !== "tool" ||
        (call.state.status !== "completed" && call.state.status !== "running") ||
        call.state.metadata?.sessionId !== jobID ||
        call.state.metadata?.childMessageID !== origin.childMessageID ||
        (call.state.status === "completed" &&
          (call.state.metadata.jobId !== jobID || call.state.metadata.background !== true))
      )
        throw new Error("Result contract original background Task differs")
      const current = snapshot({
        id: call.id,
        callID: call.callID,
        messageID: call.messageID,
        sessionID: call.sessionID,
        input: call.state.input,
        start: call.state.time.start,
      })
      if (identity.length && identity[0] !== current)
        throw new Error("Result contract original background Task changed")
      if (!identity.length) identity.push(current)
      if (call.state.status === "completed") {
        terminal.push(true)
        break
      }
      if (attempt === 100) break
      yield* Effect.sleep("50 millis")
    }
    if (!terminal.length) throw new Error("Result contract original background Task completion timed out")
    yield* check(sessions, value)
    const token = Object.freeze({})
    grants.set(token, {
      sessions,
      background,
      review: structuredClone(value),
      authority: state.authority,
      jobID,
      jobSHA: snapshot(job),
      text,
      current: context(root).current,
    })
    return token
  })

  /** Validate plugin-resolved notice rows before any persistence changes the current input. */
  export const validateNotice = Effect.fn("ResultContract.validateNotice")(function* (
    sessions: Sessions,
    token: object,
    row: SessionV1.WithParts,
  ) {
    const notice = grants.get(token)
    if (
      !notice ||
      notice.sessions !== sessions ||
      notice.row ||
      notice.prepared ||
      row.info.role !== "user" ||
      row.info.sessionID !== notice.review.sessionID ||
      row.parts.length !== 1 ||
      row.parts[0]?.type !== "text" ||
      row.parts[0].synthetic !== true ||
      row.parts[0].text !== notice.text
    )
      throw new Error("Result contract original notice differs")
    yield* freshNotice(notice)
    const current = yield* original(sessions, SessionID.make(notice.review.sessionID))
    if (
      !current ||
      digest(current) !== digest(notice.review) ||
      held.get(current)?.authority !== notice.authority ||
      !context(current).inputs.includes(MessageID.make(notice.current))
    )
      throw new Error("Result contract notice request changed")
    notice.prepared = snapshot(row)
  })

  export const publishNotice = Effect.fn("ResultContract.publishNotice")(function* (
    sessions: Sessions,
    token: object,
    row: SessionV1.WithParts,
  ) {
    const notice = grants.get(token)
    if (
      !notice ||
      notice.sessions !== sessions ||
      notice.row ||
      notice.prepared !== snapshot(row) ||
      row.info.role !== "user" ||
      row.info.sessionID !== notice.review.sessionID ||
      row.parts.length !== 1 ||
      row.parts[0]?.type !== "text" ||
      row.parts[0].synthetic !== true ||
      row.parts[0].text !== notice.text
    )
      throw new Error("Result contract original notice differs")
    yield* freshNotice(notice)
    const current = yield* original(sessions, SessionID.make(notice.review.sessionID), row)
    if (!current || digest(current) !== digest(notice.review) || held.get(current)?.authority !== notice.authority)
      throw new Error("Result contract notice request changed")
    const records = notices.get(sessions) ?? new Map<string, Notice>()
    for (const [id, previous] of records)
      if (previous.review.sessionID === notice.review.sessionID && previous.review.userID !== notice.review.userID)
        records.delete(id)
    if (
      records.size >= 128 ||
      [...records.values()].filter(
        (value) => value.review.sessionID === notice.review.sessionID && value.review.userID === notice.review.userID,
      ).length >= 16
    )
      throw new Error("Result contract notice capacity exceeded")
    const stored = window(yield* sessions.messages({ sessionID: row.info.sessionID, limit: 129 }), notice.review.userID)
    if (snapshot(stored.find((value) => value.info.id === row.info.id)) !== snapshot(row))
      throw new Error("Result contract persisted notice changed")
    yield* freshNotice(notice)
    notice.row = snapshot(row)
    records.set(row.info.id, notice)
    notices.set(sessions, records)
  })

  export const resume = Effect.fn("ResultContract.resume")(function* (
    sessions: Sessions,
    value: Review,
    selected: SessionID,
  ) {
    yield* check(sessions, value)
    const current = yield* load(sessions, selected)
    if (!current || digest(current) !== digest(value)) throw new Error("Result contract resumed request differs")
    const state = held.get(current)
    if (!state?.saved || state.saved.continuations.length >= 16)
      throw new Error("Result contract resume capacity exceeded")
    yield* check(sessions, current)
    return current
  })

  export function child(value: Review, task: z.infer<typeof invocation>) {
    const state = held.get(value)
    if (!state || digest(value) !== state.sha) throw new Error("Result contract private binding differs")
    if (state.saved && (state.saved.task.sessionID !== task.sessionID || state.saved.continuations.length >= 16))
      throw new Error("Result contract resume capacity exceeded")
    return inherited.parse({
      ...value,
      task,
      origin: state.saved?.origin ?? task,
      continuations: state.saved ? [...state.saved.continuations, state.saved.task] : [],
    })
  }
}
