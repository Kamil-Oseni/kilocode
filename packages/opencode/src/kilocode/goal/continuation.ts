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

const log = Log.create({ service: "raya-goal-continuation" })
const recovery = Semaphore.makeUnsafe(2)

const prompt = (objective: string) => `<system-reminder>
An active persistent goal must continue without a new user request.

Objective:
${objective}

Do not call chief_route. Read get_goal and identify the next concrete action toward the full objective. Use the current agent's available tools to perform work directly when appropriate. Delegate with task only when delegation is authorized and useful, or required by the current agent's routing role; an active goal alone is not a reason to delegate. Wait for delegated work before relying on its result. Do not invent unavailable tools or expand your permissions to continue.

Preserve the full objective and its constraints. Do not stop after planning. For a goal with dependencies, prefer update_goal_plan when available: read get_goal first, preserve stable task IDs, and use its current intent and plan revision. Reconcile plans marked for review or saved for an earlier objective before relying on them. A saved owner does not authorize delegation, and task status is not completion evidence. When using todowrite and a task list is useful, keep it current and identify the work actually in progress. Independent authorized tasks may be in progress together; keep dependent tasks pending until their prerequisites finish. Do not serialize genuinely parallel work merely to show one active task. Judge progress by new evidence, a completed requirement, a changed artifact, or resolution of a blocker; tool activity alone is not proof of progress. If the same action produces no new evidence, reassess the approach before repeating it.

Then read get_goal again. If a genuine decision only the user can make prevents the next step, use an available clarification tool with concrete choices and wait for the answer. Continue independent authorized work while waiting when possible. Do not block the goal merely because clarification would be helpful. If honest progress is impossible, call update_goal(status="blocked") with a specific reason.

Include every saved criterion in the audit. A criterion explicitly marked required=false may remain unverified with passed=false and an empty evidence list; all claimed successes still require evidence.

Immediately before update_goal(status="complete"), derive every concrete requirement from get_goal and cite real successful tool evidence for each one. Complete the goal only when the full objective is evidenced. Give concise progress updates without exposing private chain-of-thought.
</system-reminder>`

async function continueGoal(
  sessionID: SessionID,
  objective: string,
  directory: string,
  messageID: MessageID,
  queuedAt: number,
  signal: AbortSignal,
  files?: readonly SessionV1.FilePartInput[],
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
              parts: [...(files ?? []), { type: "text", text: prompt(objective), synthetic: true }],
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
        const user = messages.some((row) => row.info.role === "user" && row.info.id === goal.dispatch?.messageID)
        // delivered_at means SessionPrompt persisted the owned user intake. It does not mean the model turn completed.
        if (delivery && user) yield* inbox!.delivered(input.sessionID, goal.dispatch.messageID!)
        if (delivery && !delivery.delivered && !user && goal.dispatch.messageID) {
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
            complete: () => inbox!.delivered(input.sessionID, goal.dispatch!.messageID!),
          })
          return
        }
        const found = response(messages, goal.dispatch.messageID!)
        const reply = found
          ? found
          : delivery && user
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
              })
              return
            }

            const turn = yield* recover(goals.recordTurn(sid, event.properties.messageID, active.intent), active.intent)
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
