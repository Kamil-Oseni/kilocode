import { Cause, Effect, Schema } from "effect"
import type { Bus } from "@/bus"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { KiloSessionEvent } from "@/kilocode/session/event"
import { PlanArtifact } from "@/kilocode/plan-artifact"
import { RayaTask } from "."
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "raya-task-runner" })
const decode = Schema.decodeUnknownEffect(PlanArtifact.Info)

function specialist(role: string) {
  if (role === "designer") return "designer"
  if (role === "coder" || role === "code") return "coder"
  return "generalist"
}

function kind(role: string, objective: string) {
  if (role === "briefer" || role === "inbox" || /remind|notify|summary|draft replies/i.test(objective)) return "notify" as const
  return "code" as const
}

export namespace RayaTaskRunner {
  export function make(input: {
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
  }) {
    const tasks = RayaTask.make(input)
    const goals = RayaGoal.make(input)

    const seed = Effect.fn("RayaTaskRunner.seed")(function* (item: RayaTask.Agent) {
      const memory = yield* tasks.recall(item.id)
      const chunks = [item.objective]
      if (memory) chunks.push(`Role memory (do not mix with other roles):\n${memory}`)
      if (!item.plan) return chunks.join("\n\n")
      const file = Bun.file(PlanArtifact.sidecar(item.plan))
      if (!(yield* Effect.promise(() => file.exists()))) return chunks.join("\n\n")
      const raw = yield* Effect.promise(() => file.json().catch(() => undefined))
      const plan = yield* decode(raw ?? {}).pipe(Effect.orElseSucceed(() => undefined))
      if (plan) chunks.push(PlanArtifact.prompt(plan))
      return chunks.join("\n\n")
    })

    const fire = Effect.fn("RayaTaskRunner.fire")(function* (id: string) {
      const item = yield* tasks.get(id)
      if (!item.enabled) return yield* new RayaTask.GuardError({ message: "This agent is paused." })
      const history = yield* tasks.runsFor(id)
      if (history.at(-1)?.status === "running") {
        return yield* new RayaTask.GuardError({ message: "This agent is already running." })
      }
      const created = yield* input.sessions.create({ title: item.name, agent: specialist(item.role) })
      const objective = yield* seed(item)
      yield* goals.create(created.id, objective)
      const run: RayaTask.Run = {
        id: crypto.randomUUID(),
        agentID: item.id,
        at: Date.now(),
        sessionID: created.id,
        status: "running",
      }
      yield* tasks.record(run)
      yield* RayaGoalContinuation.resume({
        sessionID: created.id,
        storage: input.storage,
        sessions: input.sessions,
      }).pipe(Effect.ignore, Effect.forkDetach)
      return run
    })

    const settle = Effect.fn("RayaTaskRunner.settle")(function* (sessionID: SessionID) {
      const items = yield* tasks.list()
      for (const item of items) {
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.sessionID === sessionID && entry.status === "running")
        if (!run) continue
        const goal = yield* goals.get(sessionID)
        const status =
          goal?.status === "complete"
            ? "complete"
            : goal?.status === "blocked"
              ? "blocked"
              : goal?.status === "paused"
                ? "running"
                : "error"
        if (status === "running") continue
        const msgs = yield* input.sessions.messages({ sessionID })
        const cost = msgs.reduce((sum, row) => sum + (row.info.role === "assistant" ? row.info.cost : 0), 0)
        const summary = goal?.blockedReason || goal?.audit?.summary || item.objective
        yield* tasks.record({
          ...run,
          status,
          blockedReason: goal?.blockedReason,
          outcome: {
            kind: kind(item.role, item.objective),
            summary,
            evidence: goal?.audit?.requirements.flatMap((req) => req.evidence.map((ev) => ev.summary)),
            cost,
          },
        })
        if (item.memoryScope === "role" && summary) {
          const prior = yield* tasks.recall(item.id)
          yield* tasks.remember(item.id, [prior, summary].filter(Boolean).join("\n\n").slice(-8000))
        }
      }
    })

    const revive = Effect.fn("RayaTaskRunner.revive")(function* () {
      const items = yield* tasks.list()
      for (const item of items) {
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.status === "running")
        if (!run) continue
        yield* settle(run.sessionID)
        const again = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
        if (again?.status !== "running") continue
        yield* RayaGoalContinuation.resume({
          sessionID: run.sessionID,
          storage: input.storage,
          sessions: input.sessions,
        }).pipe(Effect.ignore, Effect.forkDetach)
      }
    })

    return { fire, settle, revive, tasks }
  }

  export function subscribe(input: {
    bus: Bus.Interface
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
  }) {
    const runner = make(input)
    return Effect.gen(function* () {
      yield* input.bus.subscribe(KiloSessionEvent.TurnClose, (event) => {
        const sid = event.properties.sessionID
        return runner.settle(sid).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("task settle failed", { sessionID: sid, err: Cause.squash(cause) })),
          ),
        )
      })
      yield* runner.revive().pipe(
        Effect.catchCause((cause) => Effect.sync(() => log.error("task revive failed", { err: Cause.squash(cause) }))),
      )
      yield* Effect.forkDaemon(loop(runner))
    })
  }
}

function loop(runner: ReturnType<typeof RayaTaskRunner.make>) {
  const tick = Effect.gen(function* () {
    const due = yield* runner.tasks.ready(Date.now())
    for (const item of due) {
      yield* runner.fire(item.id).pipe(Effect.catch(() => Effect.void))
    }
  })
  return tick.pipe(Effect.andThen(Effect.forever(Effect.sleep("60 seconds").pipe(Effect.andThen(tick)))))
}
