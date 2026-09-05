// raya_change - Milestone A idle continuation with no-tool spin suppression
import { Cause, Effect } from "effect"
import type { Bus } from "@/bus"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import { EffectBridge } from "@/effect/bridge"
import { KiloSession } from "@/kilocode/session"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import * as Log from "@opencode-ai/core/util/log"
import { RayaGoal } from "."

const log = Log.create({ service: "raya-goal-continuation" })

const prompt = (objective: string) => `<system-reminder>
An active persistent goal must continue without a new user request.

Objective:
${objective}

Do not call chief_route. If concrete work remains, call task exactly once and wait for it. Then call get_goal. If the objective is fully evidenced, call update_goal(status="complete"); if honest progress is impossible, call update_goal(status="blocked") with a plain reason. If a genuine decision only the user can make is blocking progress, call ask_options with concrete choices and wait for the answer before continuing — do not block the goal merely because you want clarification. Preserve the full objective. Do not stop after planning. Keep the session todowrite list current with exactly one in-progress item so the user sees concise work status without exposing private chain-of-thought. Immediately before update_goal(status="complete"), derive every concrete requirement from get_goal and cite real successful tool evidence for each one.
</system-reminder>`

async function continueGoal(sessionID: SessionID, objective: string, directory: string) {
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
          service.prompt({
            sessionID,
            parts: [{ type: "text", text: prompt(objective), synthetic: true }],
            goalObjective: objective, // raya_change - route the latest steered objective, not the original turn
          }),
        ),
      ),
    ),
  )
}

type Goals = ReturnType<typeof RayaGoal.make>
type Run = (sessionID: SessionID, objective: string, directory: string) => Promise<unknown>

function launch(input: {
  goals: Goals
  sessionID: SessionID
  objective: string
  directory: string
  run?: Run
  quiet?: boolean
}) {
  return Effect.tryPromise({
    try: () => (input.run ?? continueGoal)(input.sessionID, input.objective, input.directory),
    catch: (err) => err,
  }).pipe(
    Effect.catch((err) =>
      input.goals
        .update(input.sessionID, {
          status: "blocked",
          reason: `Automatic continuation failed: ${err instanceof Error ? err.message : String(err)}`,
        })
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
  export const limit = 3

  export function resume(input: {
    sessionID: SessionID
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "children"> // raya_change - evidence spans child sessions
    run?: Run
  }) {
    const goals = RayaGoal.make(input)
    return Effect.gen(function* () {
      const goal = yield* goals.get(input.sessionID)
      if (!goal || goal.status !== "active") return
      const session = yield* input.sessions.get(input.sessionID)
      yield* goals.continued(input.sessionID)
      yield* launch({
        goals,
        sessionID: input.sessionID,
        objective: goal.objective,
        directory: session.directory,
        run: input.run,
        quiet: true,
      })
    })
  }

  export function subscribe(input: {
    bus: Bus.Interface
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages" | "children"> // raya_change - evidence spans child sessions
    run?: Run
    enabled?: () => Effect.Effect<boolean> // raya_change - Milestone I continuation default
  }) {
    return Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const goals = RayaGoal.make(input)
      yield* input.bus.subscribeCallback(KiloSession.Event.TurnClose, (event) => {
        if (event.properties.parentID) return
        const sid = event.properties.sessionID
        bridge.fork(
          Effect.gen(function* () {
            if (event.properties.reason === "error") {
              if (input.enabled && !(yield* input.enabled())) return
              if (KiloSessionPromptQueue.snapshot(sid).length > 0) return
              const current = yield* goals.get(sid)
              if (!current || current.status !== "active") return
              const used = current.usage.retries ?? 0
              if (used >= limit) {
                yield* goals.update(sid, {
                  status: "blocked",
                  reason: `Automatic continuation stopped after ${limit} provider errors. Resume the goal or send a message to continue.`,
                })
                return
              }
              const messages = yield* input.sessions.messages({ sessionID: sid })
              const last = messages.toReversed().find((row) => row.info.role === "assistant")
              const err = last?.info.role === "assistant" ? last.info.error : undefined
              yield* goals.retried(sid, detail(err))
              const session = yield* input.sessions.get(sid)
              yield* launch({
                goals,
                sessionID: sid,
                objective: current.objective,
                directory: session.directory,
                run: input.run,
              })
              return
            }

            if (event.properties.reason !== "completed") return
            const turn = yield* goals.recordTurn(sid)
            if (!turn || turn.state.status !== "active" || !turn.productive) return
            if (input.enabled && !(yield* input.enabled())) return // raya_change - Milestone I
            if (KiloSessionPromptQueue.snapshot(sid).length > 0) return
            const current = yield* goals.get(sid)
            if (!current || current.status !== "active") return
            const session = yield* input.sessions.get(sid)
            yield* goals.continued(sid)
            yield* launch({
              goals,
              sessionID: sid,
              objective: current.objective,
              directory: session.directory,
              run: input.run,
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
