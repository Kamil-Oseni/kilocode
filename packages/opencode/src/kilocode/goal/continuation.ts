import * as GoalMessage from "./message"
import path from "node:path"
// raya_change - Milestone A idle continuation with no-tool spin suppression
import { Cause, Effect, Semaphore } from "effect"
import type { Bus } from "@/bus"
import type { Session } from "@/session/session"
import { SessionID, type MessageID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Storage } from "@/storage/storage"
import { EffectBridge } from "@/effect/bridge"
import { KiloSession } from "@/kilocode/session"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import * as Log from "@opencode-ai/core/util/log"
import { RayaGoal } from "."
import type { Database } from "@opencode-ai/core/database/database"
import { continuation } from "@/kilocode/task/continuation"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { gate } from "@/kilocode/session/input-gate"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { ChiefNoteEvent } from "@/kilocode/chief/event"

const log = Log.create({ service: "raya-goal-continuation" })
const recovery = Semaphore.makeUnsafe(2)

const identifier = /^[A-Za-z0-9_:-]{1,128}$/
const inspect =
  "Call chief_inspect to read their current contents and branch evidence. These interim notes are not completed task results. Do not restart or replay a child task because of this reminder."

function reminder(storage: Storage.Interface, sessionID: SessionID, goal: RayaGoal.State) {
  return Effect.gen(function* () {
    if (goal.completion === "reply") return
    const ledger = ChiefBranches.make(storage)
    const plan = yield* ledger.read(sessionID)
    if (!plan || plan.version !== 2 || !ChiefBranches.matches(plan, goal)) return
    if (!identifier.test(plan.requestID) || (plan.revision !== "" && !identifier.test(plan.revision))) return
    const notes = yield* ledger.pending({
      goalID: sessionID,
      goalCreatedAt: plan.goalCreatedAt,
      requestID: plan.requestID,
      revision: plan.revision,
    })
    if (!notes.length || notes.some((note) => !identifier.test(note.id))) return
    const ids = notes
      .slice(0, 8)
      .map((note) => note.id)
      .join(", ")
    const rest = notes.length > 8 ? `; ${notes.length - 8} more saved note IDs` : ""
    return `<system-reminder>
The current Chief plan has ${notes.length} unacknowledged specialist note${notes.length === 1 ? "" : "s"} (request ${plan.requestID}, revision ${plan.revision || "initial"}). Saved note IDs: ${ids}${rest}.
${inspect}
</system-reminder>`
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.sync(() => {
            log.warn("Chief note reminder skipped", { sessionID, err: Cause.squash(cause) })
            return undefined
          }),
    ),
  )
}

const prompt = (objective: string, completion?: "reply") =>
  completion === "reply"
    ? `<system-reminder>
Answer this worker-conversation message once, directly and naturally.

Message context:
${objective}

Use tools only when they are needed to answer accurately. Do not call update_goal for this conversational reply. The runtime records the reply as delivered after the assistant turn closes. If the request needs clarification, ask the question in your response. Do not claim that scheduled work ran unless the supplied conversation evidence proves it.
</system-reminder>`
    : `<system-reminder>
An active persistent goal must continue without a new user request.

Objective:
${objective}

Do not call chief_route. Read get_goal and identify the next concrete action toward the full objective. Use the current agent's available tools to perform work directly when appropriate. Delegate with task only when delegation is authorized and useful, or required by the current agent's routing role; an active goal alone is not a reason to delegate. Wait for delegated work before relying on its result. Do not invent unavailable tools or expand your permissions to continue.

Preserve the full objective and its constraints. Do not stop after planning. For a goal with dependencies, prefer update_goal_plan when available: read get_goal first, preserve stable task IDs, and use its current intent and plan revision. Reconcile plans marked for review or saved for an earlier objective before relying on them. A saved owner does not authorize delegation, and task status is not completion evidence. When using todowrite and a task list is useful, keep it current and identify the work actually in progress. Independent authorized tasks may be in progress together; keep dependent tasks pending until their prerequisites finish. Do not serialize genuinely parallel work merely to show one active task. Judge progress by new evidence, a completed requirement, a changed artifact, or resolution of a blocker; tool activity alone is not proof of progress. If the same action produces no new evidence, reassess the approach before repeating it.

Then read get_goal again. If a genuine decision only the user can make prevents the next step, use an available clarification tool with concrete choices and wait for the answer. Continue independent authorized work while waiting when possible. Do not block the goal merely because clarification would be helpful. If honest progress is impossible, call update_goal(status="blocked") with a specific reason.

Include every saved criterion in the audit. A criterion explicitly marked required=false may remain unverified with passed=false and an empty evidence list; all claimed successes still require evidence.

Immediately before update_goal(status="complete"), derive every concrete requirement from get_goal and cite real successful tool evidence for each one. Complete the goal only when the full objective is evidenced. Give concise progress updates without exposing private chain-of-thought.
</system-reminder>`

/** The goal text is written last, after any attachment parts, and closes the saved intake. */
function intact(
  row: SessionV1.WithParts | undefined,
  sessionID: SessionID,
  messageID: MessageID,
  goal: RayaGoal.State,
) {
  if (!row || row.info.role !== "user" || row.info.id !== messageID || row.info.sessionID !== sessionID) return false
  const part = row.parts.at(-1)
  if (
    !part ||
    part.type !== "text" ||
    part.synthetic !== true ||
    !part.id ||
    part.sessionID !== sessionID ||
    part.messageID !== messageID
  )
    return false
  const base = prompt(goal.objective, goal.completion)
  if (part.text === base) return true
  const prefix = `${base}\n\n<system-reminder>\nThe current Chief plan has `
  const suffix = `.\n${inspect}\n</system-reminder>`
  if (!part.text.startsWith(prefix) || !part.text.endsWith(suffix) || part.text.length > base.length + 1_800)
    return false
  const text = part.text.slice(prefix.length, -suffix.length)
  const match =
    /^([1-9]|1\d|2[0-4]) unacknowledged specialist (note|notes) \(request ([A-Za-z0-9_:-]{1,128}), revision ([A-Za-z0-9_:-]{1,128})\)\. Saved note IDs: (.+)$/.exec(
      text,
    )
  if (!match) return false
  const count = Number(match[1])
  if (match[2] !== (count === 1 ? "note" : "notes")) return false
  const pieces = match[5].split("; ")
  if (pieces.length > 2) return false
  const ids = pieces[0].split(", ")
  if (!ids.length || ids.length !== Math.min(count, 8) || ids.some((id) => !identifier.test(id))) return false
  return count <= 8 ? pieces.length === 1 : pieces[1] === `${count - 8} more saved note IDs`
}

async function continueGoal(
  sessionID: SessionID,
  objective: string,
  directory: string,
  messageID: MessageID,
  queuedAt: number,
  signal: AbortSignal,
  files?: readonly SessionV1.FilePartInput[],
  completion?: "reply",
  note?: string,
): Promise<unknown> {
  const [{ AppRuntime }, { SessionPrompt }, { InstanceStore }] = await Promise.all([
    import("@/effect/app-runtime"),
    import("@/session/prompt"),
    import("@/project/instance-store"),
  ])
  return AppRuntime.runPromise(
    InstanceStore.Service.use((instances) =>
      instances.provide(
        { directory },
        SessionPrompt.Service.use((service) =>
          service
            .prompt({
              sessionID,
              messageID,
              goalQueuedAt: queuedAt,
              parts: [
                ...(files ?? []),
                {
                  type: "text",
                  text: [prompt(objective, completion), note].filter(Boolean).join("\n\n"),
                  synthetic: true,
                },
              ],
              goalObjective: objective, // raya_change - route the latest steered objective, not the original turn
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.squash(cause) instanceof GoalMessage.Conflict ? Effect.void : Effect.failCause(cause),
              ),
            ),
        ),
      ),
    ),
    { signal },
  )
}

async function continueTurn(sessionID: SessionID, directory: string, signal: AbortSignal): Promise<unknown> {
  const [{ AppRuntime }, { SessionPrompt }, { InstanceStore }] = await Promise.all([
    import("@/effect/app-runtime"),
    import("@/session/prompt"),
    import("@/project/instance-store"),
  ])
  return AppRuntime.runPromise(
    InstanceStore.Service.use((instances) =>
      instances.provide(
        { directory },
        SessionPrompt.Service.use((service) => service.loop({ sessionID })),
      ),
    ),
    { signal },
  )
}

type Goals = ReturnType<typeof RayaGoal.make>
type Run = (
  sessionID: SessionID,
  objective: string,
  directory: string,
  messageID: MessageID,
  queuedAt: number,
  signal: AbortSignal,
  files?: readonly SessionV1.FilePartInput[],
  completion?: "reply",
  note?: string,
) => Promise<unknown>
type Loop = (sessionID: SessionID, directory: string, signal: AbortSignal) => Promise<unknown>

function response(messages: readonly SessionV1.WithParts[], messageID: MessageID) {
  return messages
    .filter((row) => row.info.role === "assistant" && row.info.parentID === messageID)
    .toSorted((a, b) => a.info.id.localeCompare(b.info.id))
    .at(-1)
}

function invoke(input: {
  goals: Goals
  sessionID: SessionID
  directory: string
  objective: string
  messageID: MessageID
  queuedAt: number
  revision?: string
  run?: Run
  quiet?: boolean
  files?: readonly SessionV1.FilePartInput[]
  completion?: "reply"
  note?: string
  complete?: () => Effect.Effect<void>
}) {
  return Effect.tryPromise({
    try: (signal) =>
      (input.run ?? continueGoal)(
        input.sessionID,
        input.objective,
        input.directory,
        input.messageID,
        input.queuedAt,
        signal,
        input.files,
        input.completion,
        input.note,
      ),
    catch: (err) => err,
  }).pipe(
    Effect.tap(() => input.complete?.() ?? Effect.void),
    Effect.catch((err) =>
      input.goals
        .update(
          input.sessionID,
          {
            status: "blocked",
            reason: `Automatic continuation failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          input.revision,
        )
        .pipe(
          input.quiet
            ? Effect.asVoid
            : Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error("failed to continue or block goal", {
                    sessionID: input.sessionID,
                    err: Cause.squash(cause),
                  }),
                ),
              ),
          Effect.asVoid,
        ),
    ),
  )
}

function recover<A, E, R>(effect: Effect.Effect<A, E, R>, identity?: string) {
  return identity === undefined
    ? effect
    : effect.pipe(
        Effect.retry({ times: 2, while: (err) => err instanceof RayaGoal.AuditError && err.conflict === true }),
      )
}

function launch(input: {
  goals: Goals
  sessionID: SessionID
  directory: string
  permitted: () => Effect.Effect<boolean>
  run?: Run
  quiet?: boolean
  dispatch: string
  database?: Database.Interface
  storage: Storage.Interface
}) {
  return input.permitted().pipe(
    Effect.flatMap((allowed) =>
      allowed ? input.goals.dispatched(input.sessionID, input.dispatch) : Effect.succeed(undefined),
    ),
    Effect.flatMap((goal) => {
      if (goal?.status !== "active" || !goal.dispatch?.messageID) return Effect.void
      const inbox = input.database ? RayaTaskInbox.make(input.database) : undefined
      return Effect.gen(function* () {
        const delivery = inbox ? yield* inbox.delivery(input.sessionID, goal.dispatch!.messageID!) : undefined
        const note = yield* reminder(input.storage, input.sessionID, goal)
        yield* invoke({
          goals: input.goals,
          sessionID: input.sessionID,
          directory: input.directory,
          objective: goal.objective,
          messageID: goal.dispatch!.messageID!,
          queuedAt: goal.dispatch!.queuedAt,
          revision: goal.revision,
          run: input.run,
          quiet: input.quiet,
          files: delivery?.files,
          completion: goal.completion,
          note,
          complete: delivery ? () => inbox!.delivered(input.sessionID, goal.dispatch!.messageID!) : undefined,
        })
      })
    }),
  )
}

function detail(error: unknown) {
  const text =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "data" in error
        ? JSON.stringify((error as { data?: unknown }).data)
        : error instanceof Error
          ? error.message
          : error
            ? String(error)
            : ""
  if (/Failed to read \S+ stream/i.test(text)) return "the provider stream dropped"
  return "a turn error"
}

export namespace RayaGoalContinuation {
  export const limit = RayaGoal.retryLimit
  export const expected = prompt

  export function restore(input: {
    database?: Database.Interface
    directory: string
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "children">
    enabled: () => Effect.Effect<boolean>
    idle: (sessionID: SessionID) => Effect.Effect<boolean>
    run?: Run
    loop?: Loop
  }) {
    return Effect.gen(function* () {
      if (!(yield* input.enabled())) return
      const keys = yield* input.storage.list(["raya", "goal"])
      yield* Effect.forEach(
        keys,
        (key) =>
          Effect.gen(function* () {
            if (key.length !== 3 || !(yield* input.enabled())) return
            const sessionID = SessionID.make(key[2])
            yield* Effect.gen(function* () {
              const session = yield* input.sessions.get(sessionID)
              if (path.relative(input.directory, session.directory) !== "") return
              const goal = yield* RayaGoal.make(input).get(sessionID)
              if (!goal || goal.status !== "active" || !goal.dispatch) return
              if (!(yield* input.idle(sessionID))) return
              if (
                yield* wake({
                  ...input,
                  sessionID,
                  projectID: session.projectID,
                })
              )
                return
              yield* resume({
                ...input,
                sessionID,
                permitted: () =>
                  input
                    .enabled()
                    .pipe(Effect.flatMap((enabled) => (enabled ? input.idle(sessionID) : Effect.succeed(false)))),
              })
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.sync(() =>
                      log.warn("goal startup recovery skipped", { sessionID, err: Cause.squash(cause) }),
                    ),
              ),
            )
          }).pipe(recovery.withPermits(1)),
        { concurrency: 2, discard: true },
      )
    })
  }

  /** A note event is only a hint; durable prepared and goal dispatch state decide whether one turn may start. */
  export function wake(input: {
    database?: Database.Interface
    sessionID: SessionID
    directory: string
    projectID?: string
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "children">
    enabled: () => Effect.Effect<boolean>
    idle: (sessionID: SessionID) => Effect.Effect<boolean>
    run?: Run
    loop?: Loop
  }) {
    const goals = RayaGoal.make(input)
    return Effect.gen(function* () {
      const selected = yield* Effect.gen(function* () {
        if (!(yield* input.enabled()) || !(yield* input.idle(input.sessionID))) return false
        if (KiloSessionPromptQueue.active(input.sessionID) || KiloSessionPromptQueue.snapshot(input.sessionID).length)
          return false
        const session = yield* input.sessions.get(input.sessionID)
        if (session.directory !== input.directory || (input.projectID && session.projectID !== input.projectID))
          return false
        if (!(yield* continuation({ ...input, session }))) return false
        const goal = yield* goals.get(input.sessionID)
        const plan = yield* ChiefBranches.make(input.storage).read(input.sessionID)
        if (
          !goal ||
          goal.completion === "reply" ||
          !plan ||
          plan.version !== 2 ||
          !ChiefBranches.matches(plan, goal) ||
          !plan.attention?.pending.length
        )
          return false
        const dispatch = goal.dispatch
        if (!dispatch?.messageID) return false
        const rows = yield* input.sessions.messages({ sessionID: input.sessionID })
        if (
          rows.some(
            (row) =>
              row.info.role === "user" &&
              row.info.id !== dispatch.messageID &&
              (row.info.id > dispatch.messageID! || row.info.time.created > dispatch.queuedAt),
          )
        )
          return false
        const prior = dispatch.attention
        if (prior && dispatch.phase === "finished" && plan.attention.pending.every((id) => prior.ids.includes(id)))
          return false
        if (prior && dispatch.phase !== "finished") {
          const batch = plan.attention.prepared
          return (
            batch?.id === prior.batchID &&
            batch.ids.length === prior.ids.length &&
            batch.ids.every((id, index) => id === prior.ids[index])
          )
        }
        if (dispatch.phase !== "finished") return false
        const batch = yield* ChiefBranches.make(input.storage).prepare({
          goalID: input.sessionID,
          goalCreatedAt: plan.goalCreatedAt,
          requestID: plan.requestID,
          revision: plan.revision,
        })
        if (!batch?.ids.length) return false
        if (prior?.batchID === batch.id) return false
        const next = yield* goals.continuedChief(input.sessionID, {
          goalCreatedAt: plan.goalCreatedAt,
          requestID: plan.requestID,
          revision: plan.revision,
          batchID: batch.id,
          ids: batch.ids,
        })
        return next?.dispatch?.attention?.batchID === batch.id && next.dispatch.phase === "queued"
      }).pipe(gate.withLock(input.sessionID))
      if (!selected) return false
      yield* resume({
        ...input,
        permitted: () =>
          Effect.gen(function* () {
            if (!(yield* input.enabled()) || !(yield* input.idle(input.sessionID))) return false
            return (
              !KiloSessionPromptQueue.active(input.sessionID) &&
              KiloSessionPromptQueue.snapshot(input.sessionID).length === 0
            )
          }),
      })
      return true
    })
  }

  export function subscribeAttention(input: {
    database?: Database.Interface
    directory: string
    projectID: string
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "children">
    enabled: () => Effect.Effect<boolean>
    idle: (sessionID: SessionID) => Effect.Effect<boolean>
  }) {
    return Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const listener = (event: GlobalEvent) => {
        if (
          event.directory !== input.directory ||
          event.project !== input.projectID ||
          event.payload?.type !== ChiefNoteEvent.type
        )
          return
        const data = event.payload?.properties
        if (!data || data.version !== 1 || typeof data.sessionID !== "string") return
        bridge.fork(
          wake({ ...input, sessionID: SessionID.make(data.sessionID) }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.sync(() => log.warn("Chief note wake skipped", { err: Cause.squash(cause) })),
            ),
          ),
        )
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    })
  }

  export function resume(input: {
    database?: Database.Interface
    sessionID: SessionID
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "children"> // raya_change - evidence spans child sessions
    run?: Run
    loop?: Loop
    permitted?: () => Effect.Effect<boolean>
  }) {
    const goals = RayaGoal.make(input)
    return Effect.gen(function* () {
      const goal = yield* goals.get(input.sessionID)
      if (!goal || goal.status !== "active") return
      if (input.permitted && !(yield* input.permitted())) return
      const session = yield* input.sessions.get(input.sessionID)
      if (!(yield* continuation({ ...input, session }))) return
      if (goal.dispatch?.phase === "started" && goal.dispatch.intent === (goal.intent ?? "unset")) {
        const messages = yield* input.sessions.messages({ sessionID: input.sessionID })
        const inbox = input.database ? RayaTaskInbox.make(input.database) : undefined
        const delivery =
          inbox && goal.dispatch.messageID ? yield* inbox.delivery(input.sessionID, goal.dispatch.messageID) : undefined
        const user = messages.find((row) => row.info.role === "user" && row.info.id === goal.dispatch?.messageID)
        const complete = user && goal.dispatch.messageID && intact(user, input.sessionID, goal.dispatch.messageID, goal)
        // delivered_at means SessionPrompt persisted the owned user intake. It does not mean the model turn completed.
        if (delivery && complete) yield* inbox!.delivered(input.sessionID, goal.dispatch.messageID)
        if (goal.dispatch.attention && !user && goal.dispatch.messageID && input.permitted) {
          if (!(yield* input.permitted())) return
          if (KiloSessionPromptQueue.active(input.sessionID) || KiloSessionPromptQueue.snapshot(input.sessionID).length)
            return
          const origin = goal.dispatch.attention
          const plan = yield* ChiefBranches.make(input.storage).read(input.sessionID)
          const batch = plan?.attention?.prepared
          if (
            !plan ||
            plan.version !== 2 ||
            !ChiefBranches.matches(plan, goal) ||
            plan.goalCreatedAt !== origin.goalCreatedAt ||
            plan.requestID !== origin.requestID ||
            plan.revision !== origin.revision ||
            batch?.id !== origin.batchID ||
            batch.ids.length !== origin.ids.length ||
            batch.ids.some((id, index) => id !== origin.ids[index])
          )
            return
          const note = yield* reminder(input.storage, input.sessionID, goal)
          if (!note) return
          yield* invoke({
            goals,
            sessionID: input.sessionID,
            directory: session.directory,
            objective: goal.objective,
            messageID: goal.dispatch.messageID,
            queuedAt: goal.dispatch.queuedAt,
            revision: goal.revision,
            run: input.run,
            quiet: true,
            completion: goal.completion,
            note,
          })
          return
        }
        if (delivery && !delivery.delivered && !user && goal.dispatch.messageID) {
          const note = yield* reminder(input.storage, input.sessionID, goal)
          yield* invoke({
            goals,
            sessionID: input.sessionID,
            directory: session.directory,
            objective: goal.objective,
            messageID: goal.dispatch.messageID,
            queuedAt: goal.dispatch.queuedAt,
            revision: goal.revision,
            run: input.run,
            quiet: true,
            files: delivery.files,
            completion: goal.completion,
            note,
            complete: () => inbox!.delivered(input.sessionID, goal.dispatch!.messageID!),
          })
          return
        }
        const found = response(messages, goal.dispatch.messageID!)
        const reply = found
          ? found
          : delivery && complete
            ? yield* Effect.gen(function* () {
                const current = yield* goals.get(input.sessionID)
                if (
                  !current ||
                  current.status !== "active" ||
                  current.dispatch?.phase !== "started" ||
                  current.dispatch.messageID !== goal.dispatch?.messageID ||
                  current.dispatch.intent !== (current.intent ?? "unset")
                )
                  return
                if (input.permitted && !(yield* input.permitted())) return
                const completed = yield* Effect.tryPromise({
                  try: (signal) => (input.loop ?? continueTurn)(input.sessionID, session.directory, signal),
                  catch: (err) => err,
                }).pipe(
                  Effect.as(true),
                  Effect.catch((err) =>
                    goals
                      .update(
                        input.sessionID,
                        {
                          status: "blocked",
                          reason: `Automatic continuation failed: ${err instanceof Error ? err.message : String(err)}`,
                        },
                        current.revision,
                      )
                      .pipe(Effect.as(false)),
                  ),
                )
                if (!completed) return
                const refreshed = yield* input.sessions.messages({ sessionID: input.sessionID })
                return response(refreshed, goal.dispatch!.messageID!)
              })
            : undefined
        if (!reply) return
        const settled = yield* recover(goals.finished(input.sessionID, reply.info.id), reply.info.id)
        if (!settled) return
        const turn = yield* recover(goals.recordTurn(input.sessionID, reply.info.id, goal.intent), reply.info.id)
        if (!turn || (!turn.productive && !turn.retry)) return
      }
      if (goal.dispatch?.phase === "finished" && goal.dispatch.intent === (goal.intent ?? "unset")) {
        const dispatch = goal.dispatch
        if (dispatch.outcome === "error" || dispatch.outcome === "interrupted" || !dispatch.assistantID) return
        if (!(yield* goals.finished(input.sessionID, dispatch.assistantID, "completed", true))) return
        const accounted =
          goal.accounted?.userID === dispatch.messageID && goal.accounted?.messages.includes(dispatch.assistantID)
        if (!accounted) {
          const turn = yield* recover(
            goals.recordTurn(input.sessionID, dispatch.assistantID, goal.intent),
            dispatch.assistantID,
          )
          if (!turn || (!turn.productive && !turn.retry)) return
        }
      }
      const queued = yield* recover(goals.continued(input.sessionID, goal.intent), goal.intent)
      if (!queued?.dispatch) return
      yield* launch({
        goals,
        sessionID: input.sessionID,
        directory: session.directory,
        permitted: () =>
          Effect.gen(function* () {
            if (input.permitted && !(yield* input.permitted())) return false
            return yield* continuation({ ...input, session })
          }),
        run: input.run,
        quiet: true,
        dispatch: queued.dispatch.id,
        database: input.database,
        storage: input.storage,
      })
    })
  }

  export function subscribe(input: {
    database?: Database.Interface
    bus: Bus.Interface
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "children"> // raya_change - evidence spans child sessions
    run?: Run
    enabled?: () => Effect.Effect<boolean> // raya_change - Milestone I continuation default
    idle?: (sessionID: SessionID) => Effect.Effect<boolean>
  }): Effect.Effect<void> {
    return Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const goals = RayaGoal.make(input)
      yield* input.bus.subscribeCallback(KiloSession.Event.TurnClose, (event) => {
        if (event.properties.parentID) return undefined
        const sid = event.properties.sessionID
        return bridge.fork(
          Effect.gen(function* () {
            if (event.properties.reason === "superseded") return
            if (event.properties.messageID)
              yield* recover(
                goals.finished(sid, event.properties.messageID, event.properties.reason),
                event.properties.messageID,
              )
            if (event.properties.reason === "interrupted") return
            const active = yield* goals.get(sid)
            if (!active || active.status !== "active") return
            const session = yield* input.sessions.get(sid)
            if (!(yield* continuation({ ...input, session }))) return
            if (event.properties.reason === "error") {
              const intent = event.properties.goalIntent
              if (intent !== undefined && intent !== (active.intent ?? "unset")) return
              if (input.enabled && !(yield* input.enabled())) return
              if (KiloSessionPromptQueue.snapshot(sid).length > 0) return
              const messages = yield* input.sessions.messages({ sessionID: sid })
              const last = event.properties.messageID
                ? messages.find((row) => row.info.id === event.properties.messageID)
                : messages.toReversed().find((row) => row.info.role === "assistant")
              if (event.properties.messageID) {
                if (!last || last.info.role !== "assistant" || !last.info.error) return
                const parent = last.info.parentID
                if (active.dispatch?.messageID && parent !== active.dispatch.messageID) return
                if (
                  messages.some(
                    (row) =>
                      row.info.role === "assistant" && row.info.parentID === parent && row.info.id > last.info.id,
                  )
                )
                  return
              }
              const err = last?.info.role === "assistant" ? last.info.error : undefined
              const retry = yield* recover(goals.retried(sid, detail(err), event.id, active.intent), active.intent)
              if (!retry?.dispatch || retry.status !== "active") return
              yield* launch({
                goals,
                sessionID: sid,
                directory: session.directory,
                permitted: () => continuation({ ...input, session }),
                run: input.run,
                dispatch: retry.dispatch.id,
                storage: input.storage,
              })
              return
            }

            const turn = yield* recover(goals.recordTurn(sid, event.properties.messageID, active.intent), active.intent)
            if (
              input.enabled &&
              input.idle &&
              (yield* wake({
                ...input,
                sessionID: sid,
                directory: session.directory,
                projectID: session.projectID,
                enabled: input.enabled,
                idle: input.idle,
              }))
            )
              return
            if (!turn || turn.state.status !== "active") return
            if (!turn.productive && !turn.retry) return
            if (input.enabled && !(yield* input.enabled())) return // raya_change - Milestone I
            if (KiloSessionPromptQueue.snapshot(sid).length > 0) return
            const current = yield* goals.get(sid)
            if (!current || current.status !== "active") return
            const queued = yield* recover(goals.continued(sid, active.intent), active.intent)
            if (!queued?.dispatch) return
            yield* launch({
              goals,
              sessionID: sid,
              directory: session.directory,
              permitted: () => continuation({ ...input, session }),
              run: input.run,
              dispatch: queued.dispatch.id,
              storage: input.storage,
            })
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                log.error("goal turn-close subscriber failed", {
                  sessionID: sid,
                  err: Cause.squash(cause),
                }),
              ),
            ),
          ),
        )
      })
    })
  }
}
