import { mkdir } from "node:fs/promises"
import { Cause, Effect, Schema } from "effect"
import type { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { EffectBridge } from "@/effect/bridge"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { KiloSession } from "@/kilocode/session"
import { PlanArtifact } from "@/kilocode/plan-artifact"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { RayaTask } from "."
import * as Log from "@opencode-ai/core/util/log"

const WAIT = "waiting on you"

const log = Log.create({ service: "raya-task-runner" })

function kick(input: {
  sessionID: SessionID
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
}): Effect.Effect<void> {
  return RayaGoalContinuation.resume(input).pipe(Effect.ignore) as Effect.Effect<void>
}
const decode = Schema.decodeUnknownEffect(PlanArtifact.Info)

function specialist(item: { role: string; mode?: string }) {
  const mode = item.mode?.trim()
  if (mode) return mode
  if (item.role === "designer") return "designer"
  if (item.role === "coder" || item.role === "code") return "coder"
  return "generalist"
}

function kind(role: string, objective: string) {
  if (role === "briefer" || role === "inbox" || /remind|notify|summary|draft replies/i.test(objective)) return "notify" as const
  return "code" as const
}

function open<A, E, R>(dir: string | undefined, effect: Effect.Effect<A, E, R>) {
  const path = dir?.trim()
  if (!path) return effect
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: () => new RayaTask.GuardError({ message: "Could not create that write folder." }),
    })
    const mod = yield* Effect.promise(() => import("@/project/instance-store"))
    const store = yield* mod.Service
    return yield* store.provide({ directory: path }, effect)
  })
}

export namespace RayaTaskRunner {
  type Tasks = ReturnType<typeof RayaTask.make>
  type Runner = {
    fire: (id: string) => Effect.Effect<RayaTask.Run, RayaTask.GuardError | RayaTask.NotFoundError>
    settle: (sessionID: SessionID) => Effect.Effect<void>
    park: (sessionID: SessionID, waiting: boolean) => Effect.Effect<void>
    revive: () => Effect.Effect<void>
    announce: (source: string, filter?: string) => Effect.Effect<RayaTask.Run[]>
    tasks: Tasks
  }

  export function make(input: {
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
  }): Runner {
    const tasks = RayaTask.make(input)
    const goals = RayaGoal.make(input)

    const seed = Effect.fn("RayaTaskRunner.seed")(function* (item: RayaTask.Agent) {
      const memory = yield* tasks.recall(item.id)
      const chunks = [item.objective]
      if (item.dir?.trim()) {
        chunks.push(`Write new files only in ${item.dir.trim()}. You may read from anywhere else.`)
      }
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
      const created = yield* open(item.dir, input.sessions.create({
        title: item.name,
        agent: specialist(item),
        model:
          item.mode || !item.model
            ? undefined
            : {
                providerID: ProviderV2.ID.make(item.model.providerID),
                id: ModelV2.ID.make(item.model.id),
              },
        permission: RayaTask.rules(item),
      }))
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
      yield* kick({
        sessionID: created.id,
        storage: input.storage,
        sessions: input.sessions,
      }).pipe(Effect.forkDetach)
      return run
    })

    const park = Effect.fn("RayaTaskRunner.park")(function* (sessionID: SessionID, waiting: boolean) {
      const items = yield* tasks.list()
      for (const item of items) {
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.sessionID === sessionID)
        if (!run || run.status === "complete" || run.status === "error") continue
        if (waiting) {
          if (run.status === "blocked" && run.blockedReason === WAIT) continue
          yield* tasks.record({ ...run, status: "blocked", blockedReason: WAIT })
          continue
        }
        if (run.status !== "blocked" || run.blockedReason !== WAIT) continue
        yield* tasks.record({ ...run, status: "running", blockedReason: undefined })
      }
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
        yield* kick({
          sessionID: run.sessionID,
          storage: input.storage,
          sessions: input.sessions,
        }).pipe(Effect.forkDetach)
      }
    })

    const announce = Effect.fn("RayaTaskRunner.announce")(function* (source: string, filter?: string) {
      const items = yield* tasks.listenFor(source, filter)
      const runs: RayaTask.Run[] = []
      for (const item of items) {
        const run = yield* fire(item.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (run) runs.push(run)
      }
      return runs
    })

    return {
      fire: fire as Runner["fire"],
      settle: settle as Runner["settle"],
      park: park as Runner["park"],
      revive: revive as Runner["revive"],
      announce: announce as Runner["announce"],
      tasks,
    }
  }

  export function subscribe(input: {
    bus: Bus.Interface
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
  }) {
    const runner = make(input)
    return Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      yield* input.bus.subscribeCallback(KiloSession.Event.TurnClose, (event) => {
        const sid = event.properties.sessionID
        bridge.fork(
          runner.settle(sid).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("task settle failed", { sessionID: sid, err: Cause.squash(cause) })),
            ),
          ),
        )
      })
      yield* Effect.sync(() => {
        const asked = new Set(["permission.asked", "question.asked"])
        const replied = new Set(["permission.replied", "question.replied", "question.rejected"])
        GlobalBus.on("event", (event) => {
          const type = event.payload?.type
          const raw = event.payload?.properties?.sessionID
          if (!type || typeof raw !== "string") return
          const waiting = asked.has(type)
          if (!waiting && !replied.has(type)) return
          const sid = (() => {
            try {
              return SessionID.make(raw)
            } catch {
              return
            }
          })()
          if (!sid) return
          bridge.fork(
            runner.park(sid, waiting).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("task park failed", { sessionID: sid, err: Cause.squash(cause) })),
              ),
            ),
          )
        })
      })
      yield* runner.revive().pipe(
        Effect.catchCause((cause) => Effect.sync(() => log.error("task revive failed", { err: Cause.squash(cause) }))),
      )
      const tick = Effect.gen(function* () {
        const due = yield* runner.tasks.ready(Date.now())
        for (const item of due) {
          yield* runner.fire(item.id).pipe(Effect.catch(() => Effect.void))
        }
      })
      yield* tick
        .pipe(Effect.andThen(Effect.forever(Effect.sleep("60 seconds").pipe(Effect.andThen(tick)))))
        .pipe(Effect.forkDetach)
    })
  }
}
