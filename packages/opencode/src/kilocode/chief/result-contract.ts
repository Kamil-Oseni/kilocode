import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as Outcome from "@opencode-ai/core/kilocode/background-outcome"
import { Committed } from "@opencode-ai/schema/kilocode/result-notice"
import type { EventV2 } from "@opencode-ai/core/event"
import * as Receipts from "./notice-receipt"
import { format } from "../tool/read-directory"
import { z } from "zod"
import { digest as evidence } from "@opencode-ai/core/kilocode/evidence-digest"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { BackgroundJob } from "@/background/job"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { RayaChief } from "."
import { TaskName } from "../tool/task-name"
import { resumeHint } from "../task-resume"
import type { Storage } from "@/storage/storage"
import * as GoalInput from "../goal/task-input"

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
const reasons = new Map([
  ["Result contract original background join timed out; completion remains unconfirmed", "join-timeout"],
  ["Result contract joined background completion is unavailable", "join-unavailable"],
  ["Result contract original background join changed", "join-changed"],
  ["Result contract original background Task completion timed out", "task-timeout"],
  ["Result contract notice terminal differs", "child-terminal"],
  ["Result contract notice child differs", "child-binding"],
  ["Result contract notice Task differs", "task-binding"],
  ["Result contract durable Chief evidence changed", "chief-binding"],
  ["Result contract durable previous input differs", "previous-input"],
  ["Result contract durable source evidence changed", "source-changed"],
  ["Result notice original completion was already committed", "already-committed"],
])
const diagnostic =
  (stage: "notice" | "join" | "source" | "publication") =>
  <A, E, R>(body: Effect.Effect<A, E, R>) =>
    body.pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void
        const err = Cause.squash(exit.cause)
        const name = err instanceof Error ? err.constructor.name : "Unknown"
        return Effect.logError("Result contract completion refused", {
          stage,
          exception: /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "Unknown",
          reason: err instanceof Error ? (reasons.get(err.message) ?? "proof-refused") : "proof-refused",
        })
      }),
    )
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
  receipt?: Receipts.Receipt
  storage?: Pick<Storage.Interface, "read">
  goal?: string
  source?: string
}
const grants = new WeakMap<object, Notice>()
const notices = new WeakMap<Sessions, Map<string, Notice>>()
const freshNotice = Effect.fn("ResultContract.freshNotice")(function* (notice: Notice) {
  // Committed notices retain their original joined generation; a later child job is not that outcome.
  const job =
    notice.row && notice.receipt ? yield* outcome(notice.receipt.job) : yield* notice.background.get(notice.jobID)
  if (!job || snapshot(job) !== notice.jobSHA) throw new Error("Result contract background completion changed")
  if (notice.goal !== undefined && !notice.row) {
    const sessionID = SessionID.make(notice.review.sessionID)
    const goal = notice.storage ? yield* GoalInput.stamp(notice.storage, sessionID).pipe(Effect.orDie) : {}
    const parent = yield* notice.sessions.get(sessionID)
    if (snapshot(goal) !== notice.goal || (parent.metadata?.["raya.goal.open"] === true && !goal[GoalInput.key]))
      throw new Error("Result contract original goal changed")
    if (
      notice.source !== undefined &&
      snapshot(
        yield* sources(
          notice.sessions,
          {
            sessionID: notice.review.sessionID,
            userID: notice.review.userID,
            sha: digest(notice.review),
            authority: notice.authority,
            current: notice.current,
            route: notice.review.route,
          },
          job,
        ),
      ) !== notice.source
    )
      throw new Error("Result contract original notice source changed")
  }
})
const continuation = Effect.fn("ResultContract.continuation")(function* (
  sessions: Sessions,
  row: SessionV1.WithParts,
): Effect.fn.Return<string, Session.NotFound> {
  const notice = notices.get(sessions)?.get(row.info.id)
  if (notice) {
    if (notice.row !== snapshot(row) || row.info.sessionID !== notice.review.sessionID)
      throw new Error("Result contract synthetic continuation is unauthenticated")
    yield* freshNotice(notice)
    if (notice.receipt) {
      const database = yield* Effect.serviceOption(Database.Service)
      if (Option.isNone(database)) throw new Error("Result contract durable notice service is unavailable")
      const receipt = yield* Receipts.make(database.value).get({
        sessionID: row.info.sessionID,
        messageID: row.info.id,
      })
      if (!receipt || snapshot(receipt) !== snapshot(notice.receipt))
        throw new Error("Result contract durable notice receipt changed")
      yield* durable(sessions, receipt, row)
    }
    return digest(notice.review)
  }
  const database = yield* Effect.serviceOption(Database.Service)
  if (Option.isNone(database)) throw new Error("Result contract synthetic continuation is unauthenticated")
  const receipt = yield* Receipts.make(database.value).get({ sessionID: row.info.sessionID, messageID: row.info.id })
  if (!receipt || receipt.row.sha !== snapshot(row))
    throw new Error("Result contract synthetic continuation is unauthenticated")
  yield* durable(sessions, receipt, row)
  const retained = yield* Receipts.make(database.value).get({ sessionID: row.info.sessionID, messageID: row.info.id })
  if (!retained || snapshot(retained) !== snapshot(receipt))
    throw new Error("Result contract synthetic continuation receipt changed")
  return receipt.root.sha
})

const outcome = Effect.fn("ResultContract.outcome")(function* (input: Receipts.Receipt["job"]) {
  const service = yield* Effect.serviceOption(Outcome.Service)
  if (Option.isNone(service)) throw new Error("Result contract joined background completion is unavailable")
  const value = yield* service.value.get(input).pipe(Effect.orDie)
  if (
    !value ||
    value.phase !== "joined" ||
    !value.terminal ||
    value.identitySHA !== input.identitySHA ||
    value.terminalSHA !== input.terminalSHA ||
    value.identity.origins.length !== 1 ||
    value.identity.origins[0]?.callID !== input.callID ||
    value.identity.origins[0]?.childMessageID !== input.inputID
  )
    throw new Error("Result contract joined background completion changed")
  return value.terminal
})

const sources = Effect.fn("ResultContract.noticeSources")(function* (
  sessions: Sessions,
  root: Receipts.Receipt["root"],
  job: NonNullable<Outcome.Receipt["terminal"]>,
  historical = false,
): Effect.fn.Return<Receipts.Receipt["source"], Session.NotFound> {
  const origin = job.origins?.[0]
  if (
    job.origins?.length !== 1 ||
    !origin ||
    origin.sessionID !== root.sessionID ||
    origin.childSessionID !== job.id ||
    !origin.childMessageID
  )
    throw new Error("Result contract notice producer differs")
  const rows = window(yield* sessions.messages({ sessionID: SessionID.make(root.sessionID), limit: 129 }), root.userID)
  const parent = rows.find((row) => row.info.id === origin.messageID)
  const calls =
    parent?.parts.filter((part) => part.type === "tool" && part.tool === "task" && part.callID === origin.callID) ?? []
  const call = calls[0]
  if (
    parent?.info.role !== "assistant" ||
    parent.info.error ||
    calls.length !== 1 ||
    call?.type !== "tool" ||
    call.sessionID !== root.sessionID ||
    call.messageID !== parent.info.id ||
    call.state.status !== "completed" ||
    call.state.metadata.jobId !== job.id ||
    call.state.metadata.background !== true ||
    call.state.metadata.sessionId !== job.id ||
    call.state.metadata.childMessageID !== origin.childMessageID
  )
    throw new Error("Result contract notice Task differs")
  const info = parent.info
  const previous = rows.find((row) => row.info.id === info.parentID)
  if (
    previous?.info.role !== "user" ||
    previous.info.sessionID !== root.sessionID ||
    previous.info.id < root.userID ||
    previous.info.id >= parent.info.id
  )
    throw new Error("Result contract notice Task input differs")
  if (previous.info.id !== root.userID && (yield* continuation(sessions, previous)) !== root.sha)
    throw new Error("Result contract notice Task continuation differs")
  const child = yield* sessions.get(SessionID.make(job.id))
  const current = inherited.parse(child.metadata?.[ResultContract.key])
  const chain = [...current.continuations, current.task]
  if (
    digest(chain[0]) !== digest(current.origin) ||
    new Set(chain.map((item) => item.callID)).size !== chain.length ||
    new Set(chain.map((item) => item.inputID)).size !== chain.length ||
    chain.some(
      (item, index) =>
        item.sessionID !== job.id ||
        (index > 0 &&
          (item.inputID <= chain[index - 1].inputID || item.parentMessageID <= chain[index - 1].parentMessageID)),
    )
  )
    throw new Error("Result contract notice resume chain differs")
  const index = historical
    ? chain.findIndex(
        (item) =>
          item.inputID === origin.childMessageID &&
          item.parentMessageID === origin.messageID &&
          item.callID === origin.callID,
      )
    : chain.length - 1
  if (index < 0) throw new Error("Result contract notice original child invocation absent")
  // Reconstruct only the immutable original prefix, whose complete bytes remain pinned by the receipt.
  const saved = historical
    ? inherited.parse({ ...current, task: chain[index], continuations: chain.slice(0, index) })
    : current
  const owner = TaskName.read(child.metadata?.[TaskName.key])
  if (
    child.parentID !== root.sessionID ||
    digest(core(saved)) !== root.sha ||
    saved.task.sessionID !== job.id ||
    saved.task.inputID !== origin.childMessageID ||
    saved.task.parentMessageID !== origin.messageID ||
    saved.task.callID !== origin.callID ||
    !owner ||
    owner.provenance.parentSessionID !== root.sessionID ||
    owner.provenance.parentMessageID !== saved.origin.parentMessageID ||
    owner.provenance.callID !== saved.origin.callID
  )
    throw new Error("Result contract notice child differs")
  const children = window(yield* sessions.messages({ sessionID: child.id, limit: 129 }), origin.childMessageID).filter(
    (row) => !historical || !chain[index + 1] || row.info.id < chain[index + 1].inputID,
  )
  const input = children.find((row) => row.info.id === origin.childMessageID)
  const terminal = children.findLast(
    (row) => row.info.role === "assistant" && row.info.parentID === origin.childMessageID,
  )
  if (
    input?.info.role !== "user" ||
    input.info.sessionID !== child.id ||
    children.findLast((row) => row.info.role === "user")?.info.id !== input.info.id ||
    terminal?.info.role !== "assistant" ||
    terminal.info.parentID !== input.info.id ||
    terminal.info.sessionID !== child.id ||
    !Number.isSafeInteger(terminal.info.time.completed) ||
    terminal.info.time.completed! < input.info.time.created ||
    (job.status === "completed" && (terminal.info.error || terminal.info.finish !== "stop"))
  )
    throw new Error("Result contract notice terminal differs")
  const reads: Receipts.Receipt["source"]["reads"] = []
  const ids = new Set<string>()
  for (const row of children) {
    if (row.info.role !== "assistant" || row.info.parentID !== input.info.id || row.info.error) continue
    for (const part of row.parts) {
      if (part.type !== "tool" || part.tool !== "read" || part.state.status !== "completed") continue
      if (
        reads.length >= 16 ||
        ids.has(part.id) ||
        ids.has(part.callID) ||
        part.sessionID !== child.id ||
        part.messageID !== row.info.id ||
        !part.callID ||
        !Number.isSafeInteger(part.state.time.start) ||
        !Number.isSafeInteger(part.state.time.end) ||
        part.state.time.start < input.info.time.created ||
        part.state.time.end < part.state.time.start ||
        part.state.time.end > terminal.info.time.completed!
      )
        throw new Error("Result contract notice Read differs")
      ids.add(part.id)
      ids.add(part.callID)
      const display = part.state.metadata.display
      if (display && typeof display === "object" && "type" in display && display.type === "directory") {
        const value = z
          .object({
            type: z.literal("directory"),
            path: z.string().min(1),
            entries: z.array(z.string().min(1)).max(256),
            offset: z.literal(1),
            totalEntries: z.number().int().nonnegative(),
            truncated: z.literal(false),
          })
          .strict()
          .parse(display)
        if (
          part.state.metadata.truncated !== false ||
          value.totalEntries !== value.entries.length ||
          new Set(value.entries).size !== value.entries.length ||
          Buffer.byteLength(value.path) > 4096 ||
          value.entries.some((name) => Buffer.byteLength(name) > 4096) ||
          part.state.output !== format(value)
        )
          throw new Error("Result contract notice directory evidence differs")
      }
      reads.push({ id: part.id, sha: snapshot({ row: row.info, part }) })
    }
  }
  return {
    task: snapshot({
      row: {
        id: parent.info.id,
        sessionID: parent.info.sessionID,
        parentID: parent.info.parentID,
        agent: parent.info.agent,
      },
      call,
    }),
    child: snapshot({ id: child.id, parentID: child.parentID, saved, owner }),
    input: snapshot(input),
    terminal: snapshot(terminal),
    reads,
  }
}, diagnostic("source"))

const durable = Effect.fn("ResultContract.durableNotice")(function* (
  sessions: Sessions,
  receipt: Receipts.Receipt,
  row: SessionV1.WithParts,
): Effect.fn.Return<void, Session.NotFound> {
  if (
    row.info.role !== "user" ||
    row.info.sessionID !== receipt.root.sessionID ||
    row.info.id !== receipt.row.messageID ||
    row.parts.length !== 1 ||
    row.parts[0]?.type !== "text" ||
    row.parts[0].synthetic !== true ||
    snapshot(row) !== receipt.row.sha
  )
    throw new Error("Result contract durable notice differs")
  const root = yield* sessions.get(SessionID.make(receipt.root.sessionID))
  const decision = RayaChief.history(root.metadata).at(-1)
  const rows = window(yield* sessions.messages({ sessionID: root.id, limit: 129 }), receipt.root.userID)
  const previous = rows.find((value) => value.info.id === receipt.root.current)
  if (
    previous?.info.role !== "user" ||
    previous.info.sessionID !== root.id ||
    previous.info.id < receipt.root.userID ||
    previous.info.id >= row.info.id
  )
    throw new Error("Result contract durable previous input differs")
  if (previous.info.id !== receipt.root.userID && (yield* continuation(sessions, previous)) !== receipt.root.sha)
    throw new Error("Result contract durable previous continuation differs")
  const user = rows.find((row) => row.info.id === receipt.root.userID)
  const parent = rows.find((row) => row.info.id === receipt.root.route.messageID)
  const call = parent?.parts.find((part) => part.id === receipt.root.route.partID)
  if (
    root.parentID ||
    !decision ||
    user?.info.role !== "user" ||
    user.info.agent !== "auto" ||
    decision.userID !== user.info.id ||
    RayaChief.request(root.metadata) !== decision.request ||
    RayaChief.requestText(user.parts) !== decision.request ||
    parent?.info.role !== "assistant" ||
    parent.info.error ||
    parent.info.sessionID !== root.id ||
    user.info.sessionID !== root.id ||
    parent.info.parentID !== user.info.id ||
    call?.type !== "tool" ||
    call.tool !== "chief_route" ||
    call.state.status !== "completed" ||
    call.callID !== receipt.root.route.callID ||
    call.sessionID !== root.id ||
    call.messageID !== parent.info.id ||
    call.state.input.result !== decision.result ||
    call.state.input.access !== decision.access ||
    !Number.isSafeInteger(call.state.time.start) ||
    !Number.isSafeInteger(call.state.time.end) ||
    call.state.time.start < user.info.time.created ||
    call.state.time.end < call.state.time.start ||
    call.state.output !== JSON.stringify(decision)
  )
    throw new Error("Result contract durable root differs")
  const value = proof.parse({
    version: 1,
    kind: decision.result,
    sessionID: root.id,
    userID: user.info.id,
    request: decision.request,
    decisionSHA: digest(decision),
    route: receipt.root.route,
  })
  if (
    digest(value) !== receipt.root.sha ||
    snapshot({
      user,
      call: {
        messageID: parent.info.id,
        partID: call.id,
        callID: call.callID,
        input: call.state.input,
        output: call.state.output,
      },
    }) !== receipt.root.authority
  )
    throw new Error("Result contract durable Chief evidence changed")
  const job = yield* outcome(receipt.job)
  if (snapshot(yield* sources(sessions, receipt.root, job, true)) !== snapshot(receipt.source))
    throw new Error("Result contract durable source evidence changed")
})

const joined = Effect.fn("ResultContract.joinedNotice")(function* (
  sessions: Sessions,
  background: Pick<BackgroundJob.Interface, "get">,
  value: ResultContract.Review,
  job: NonNullable<Outcome.Receipt["terminal"]>,
) {
  const service = yield* Effect.serviceOption(Outcome.Service)
  if (Option.isNone(service)) return
  if (!job.revision) throw new Error("Result contract original background revision is unavailable")
  const identity = {
    id: job.id,
    revision: job.revision,
    type: job.type,
    started_at: job.started_at,
    origins: job.origins,
  }
  for (let attempt = 0; attempt <= 100; attempt++) {
    yield* ResultContract.check(sessions, value)
    const original = yield* background.get(job.id)
    if (!original || snapshot(original) !== snapshot(job))
      throw new Error("Result contract background completion changed before join")
    const current = yield* service.value.get({ id: job.id, revision: job.revision }).pipe(Effect.orDie)
    if (current) {
      if (
        snapshot(current.identity) !== snapshot(identity) ||
        (current.phase !== "admitted" && (!current.terminal || snapshot(current.terminal) !== snapshot(job)))
      )
        throw new Error("Result contract original background join changed")
      if (current.phase === "joined") {
        if (!current.terminalSHA) throw new Error("Result contract original background join is incomplete")
        yield* ResultContract.check(sessions, value)
        return
      }
    }
    if (attempt === 100) break
    yield* Effect.sleep("50 millis")
  }
  throw new Error("Result contract original background join timed out; completion remains unconfirmed")
}, diagnostic("join"))

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
          const authority = yield* continuation(sessions, parent)
          if (authority !== digest(core(saved))) throw new Error("Result contract parent continuation differs")
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

  /** Bind only a committed original completion input to the goal scope captured by its actual Task. */
  export const follow = Effect.fn("ResultContract.goalInput")(function* (
    sessions: Sessions,
    sessionID: SessionID,
    inputID: MessageID,
    scope: GoalInput.Scope,
  ) {
    const value = yield* load(sessions, sessionID)
    if (!value) return undefined
    const selected = context(value)
    if (selected.current !== inputID || selected.input === inputID) return undefined
    const database = yield* Effect.serviceOption(Database.Service)
    if (Option.isNone(database)) return undefined
    const receipt = yield* Receipts.make(database.value).get({ sessionID, messageID: inputID })
    if (!receipt || receipt.root.sha !== digest(value)) return undefined
    const rows = window(yield* sessions.messages({ sessionID, limit: 129 }), value.userID)
    const row = rows.find((row) => row.info.id === inputID)
    if (!row) throw new Error("Result contract original goal notice absent")
    yield* durable(sessions, receipt, row)
    const job = yield* outcome(receipt.job)
    const origin = job.origins?.[0]
    const parent = rows.find((row) => row.info.id === origin?.messageID)
    const call = parent?.parts.find((part) => part.type === "tool" && part.callID === origin?.callID)
    if (call?.type !== "tool" || call.tool !== "task" || call.state.status !== "completed")
      throw new Error("Result contract original goal Task absent")
    if (snapshot({ scope }) !== snapshot({ scope: call.state.metadata?.[GoalInput.key] })) return { input: undefined }
    return { input: selected.input }
  })

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
    storage?: Pick<Storage.Interface, "read">,
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
    const goals: string[] = []
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
        const goal = storage ? yield* GoalInput.stamp(storage, SessionID.make(value.sessionID)).pipe(Effect.orDie) : {}
        const parent = yield* sessions.get(SessionID.make(value.sessionID))
        if (parent.metadata?.["raya.goal.open"] === true && !goal[GoalInput.key])
          throw new Error("Result contract original goal changed")
        if (snapshot({ scope: goal[GoalInput.key] }) !== snapshot({ scope: call.state.metadata?.[GoalInput.key] }))
          throw new Error("Result contract original goal changed")
        goals.push(snapshot(goal))
        terminal.push(true)
        break
      }
      if (attempt === 100) break
      yield* Effect.sleep("50 millis")
    }
    if (!terminal.length) throw new Error("Result contract original background Task completion timed out")
    yield* check(sessions, value)
    yield* joined(sessions, background, value, job)
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
      storage,
      goal: goals[0],
      source: storage
        ? snapshot(
            yield* sources(
              sessions,
              {
                sessionID: value.sessionID,
                userID: value.userID,
                sha: digest(value),
                authority: state.authority,
                current: context(root).current,
                route: value.route,
              },
              job,
            ),
          )
        : undefined,
    })
    return token
  }, diagnostic("notice"))

  /** Only the original private completion grant can retain Auto's current work phase. */
  export const continuing = Effect.fn("ResultContract.continuing")(function* (
    sessions: Sessions,
    token: object,
    sessionID: SessionID,
    parts: readonly { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[],
    objective?: string,
  ) {
    const notice = grants.get(token)
    if (
      !notice ||
      notice.sessions !== sessions ||
      notice.row ||
      notice.review.sessionID !== sessionID ||
      parts.length !== 1 ||
      parts[0]?.type !== "text" ||
      parts[0].synthetic !== true ||
      parts[0].ignored === true ||
      parts[0].text !== notice.text ||
      (objective !== undefined && objective !== notice.review.request)
    )
      throw new Error("Result contract original notice differs")
    yield* freshNotice(notice)
    const current = yield* original(sessions, sessionID)
    if (
      !current ||
      digest(current) !== digest(notice.review) ||
      held.get(current)?.authority !== notice.authority ||
      !context(current).inputs.includes(MessageID.make(notice.current))
    )
      throw new Error("Result contract notice request changed")
    return notice.review.request
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

  /** Original local publication commits data and its non-replayable receipt together. */
  export const commitNotice = Effect.fn("ResultContract.commitNotice")(
    function* (
      sessions: Sessions,
      token: object,
      row: SessionV1.WithParts,
      input: { database: Database.Interface; events: Pick<EventV2.Interface, "publish"> },
    ) {
      const notice = grants.get(token)
      if (!notice || notice.sessions !== sessions || notice.row)
        throw new Error("Result contract original notice is unavailable")
      if (!notice.prepared) yield* validateNotice(sessions, token, row)
      if (
        notice.prepared !== snapshot(row) ||
        row.info.role !== "user" ||
        row.parts.length !== 1 ||
        row.parts[0]?.type !== "text" ||
        row.parts[0].synthetic !== true ||
        row.parts[0].ignored === true
      )
        throw new Error("Result contract original notice differs")
      const service = yield* Effect.serviceOption(Outcome.Service)
      if (Option.isNone(service)) throw new Error("Result contract joined background completion is unavailable")
      const job = yield* notice.background.get(notice.jobID)
      if (!job?.revision || snapshot(job) !== notice.jobSHA)
        throw new Error("Result contract original background completion changed")
      const joined = yield* service.value.get({ id: job.id, revision: job.revision }).pipe(Effect.orDie)
      if (
        !joined ||
        joined.phase !== "joined" ||
        !joined.terminal ||
        !joined.terminalSHA ||
        snapshot(joined.terminal) !== snapshot(job)
      )
        throw new Error("Result contract joined background completion is unavailable")
      const root = {
        sessionID: notice.review.sessionID,
        userID: notice.review.userID,
        sha: digest(notice.review),
        authority: notice.authority,
        current: notice.current,
        route: notice.review.route,
      }
      const origin = joined.identity.origins[0]
      if (joined.identity.origins.length !== 1 || !origin?.childMessageID)
        throw new Error("Result contract original producer differs")
      const receipt = Receipts.schema.parse({
        version: 1,
        root,
        row: { messageID: row.info.id, sha: snapshot(row) },
        job: {
          id: job.id,
          revision: job.revision,
          callID: origin.callID,
          inputID: origin.childMessageID,
          identitySHA: joined.identitySHA,
          terminalSHA: joined.terminalSHA,
        },
        source: yield* sources(sessions, root, joined.terminal),
      })
      const records = Receipts.make(input.database)
      yield* input.events.publish(
        Committed,
        { sessionID: row.info.sessionID, info: row.info, part: row.parts[0], time: row.info.time.created },
        {
          prepare: () =>
            Effect.gen(function* () {
              if (grants.get(token) !== notice || notice.row || notice.prepared !== snapshot(row))
                throw new Error("Result contract original notice changed")
              yield* freshNotice(notice)
              const current = yield* original(sessions, SessionID.make(root.sessionID))
              if (
                !current ||
                digest(current) !== root.sha ||
                held.get(current)?.authority !== root.authority ||
                !context(current).inputs.includes(MessageID.make(root.current))
              )
                throw new Error("Result contract original notice request changed")
              if (yield* records.get({ sessionID: row.info.sessionID, messageID: row.info.id }))
                throw new Error("Result contract notice was already committed")
              const existing = yield* sessions.messages({ sessionID: row.info.sessionID, limit: 129 })
              if (existing.some((value) => value.info.id === row.info.id))
                throw new Error("Result contract notice message already exists")
              yield* durable(sessions, receipt, row)
            }).pipe(Effect.orDie),
          commit: () =>
            Effect.gen(function* () {
              yield* durable(sessions, receipt, row)
              yield* records.insert(receipt)
            }).pipe(Effect.orDie),
        },
      )
      const stored = yield* records.get({ sessionID: row.info.sessionID, messageID: row.info.id })
      if (!stored || snapshot(stored) !== snapshot(receipt)) throw new Error("Result contract committed notice changed")
      yield* durable(sessions, stored, row)
      yield* publishNotice(sessions, token, row)
      notice.receipt = structuredClone(stored)
    },
    Effect.orDie,
    diagnostic("publication"),
  )

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
