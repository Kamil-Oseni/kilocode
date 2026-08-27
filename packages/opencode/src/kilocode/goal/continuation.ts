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

Perform the next concrete unit of work now. Preserve the full objective. Do not stop after planning. Use work or verification tools when progress is possible. Immediately before update_goal(status="complete"), call get_goal to obtain the exact eligible evidence IDs, then derive every concrete requirement and cite real successful tool evidence for each one. If evidence is missing, keep working. A goal must never remain active while waiting for user approval, input, credentials, or another external dependency: call update_goal(status="blocked") with a plain reason instead of repeatedly checking unchanged evidence.
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
          }),
        ),
      ),
    ),
  )
}

export namespace RayaGoalContinuation {
  export function resume(input: {
    sessionID: SessionID
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages"> // raya_change
    run?: (sessionID: SessionID, objective: string, directory: string) => Promise<unknown>
  }) {
    const goals = RayaGoal.make(input)
    return Effect.gen(function* () {
      const goal = yield* goals.get(input.sessionID)
      if (!goal || goal.status !== "active") return
      const session = yield* input.sessions.get(input.sessionID)
      yield* goals.continued(input.sessionID)
      yield* Effect.tryPromise({
        try: () => (input.run ?? continueGoal)(input.sessionID, goal.objective, session.directory),
        catch: (err) => err,
      }).pipe(
        Effect.catch((err) =>
          goals
            .update(input.sessionID, {
              status: "blocked",
              reason: `Automatic continuation failed: ${err instanceof Error ? err.message : String(err)}`,
            })
            .pipe(Effect.asVoid),
        ),
      )
    })
  }

  export function subscribe(input: {
    bus: Bus.Interface
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "get" | "messages"> // raya_change
    run?: (sessionID: SessionID, objective: string, directory: string) => Promise<unknown>
    enabled?: () => Effect.Effect<boolean> // raya_change - Milestone I continuation default
  }) {
    return Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const goals = RayaGoal.make(input)
      yield* input.bus.subscribeCallback(KiloSession.Event.TurnClose, (event) => {
        if (event.properties.reason !== "completed" || event.properties.parentID) return
        bridge.fork(
          Effect.gen(function* () {
            const turn = yield* goals.recordTurn(event.properties.sessionID)
            if (!turn || turn.state.status !== "active" || !turn.productive) return
            if (input.enabled && !(yield* input.enabled())) return // raya_change - Milestone I
            if (KiloSessionPromptQueue.snapshot(event.properties.sessionID).length > 0) return
            const current = yield* goals.get(event.properties.sessionID)
            if (!current || current.status !== "active") return
            const session = yield* input.sessions.get(event.properties.sessionID)
            yield* goals.continued(event.properties.sessionID)
            yield* Effect.tryPromise({
              try: () => (input.run ?? continueGoal)(event.properties.sessionID, current.objective, session.directory),
              catch: (err) => err,
            }).pipe(
              Effect.catch((err) =>
                goals
                  .update(event.properties.sessionID, {
                    status: "blocked",
                    reason: `Automatic continuation failed: ${err instanceof Error ? err.message : String(err)}`,
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.sync(() =>
                        log.error("failed to continue or block goal", {
                          sessionID: event.properties.sessionID,
                          err: Cause.squash(cause),
                        }),
                      ),
                    ),
                    Effect.asVoid,
                  ),
              ),
            )
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                log.error("goal turn-close subscriber failed", {
                  sessionID: event.properties.sessionID,
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
