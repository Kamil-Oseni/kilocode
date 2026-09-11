import { mkdir } from "node:fs/promises"
import { Cause, Effect, Option, Schema } from "effect"
import type { Bus } from "@/bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
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
import { RayaTaskInbox, posted, type Record as Note } from "./inbox"
import { claim } from "./claim"
import { inspect, recover } from "./recovery"
import { poll } from "./poll"
import { InstanceState } from "@/effect/instance-state"
import type { Database } from "@opencode-ai/core/database/database"
import { scheduler } from "./scheduler"
import { reconcile as recovery } from "./reconcile"
import { RayaTaskSnapshot } from "./snapshot"
import * as Log from "@opencode-ai/core/util/log"

const WAIT = "waiting on you"

const log = Log.create({ service: "raya-task-runner" })

function kick(input: {
  database?: Database.Interface
  sessionID: SessionID
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
}): Effect.Effect<void> {
  return RayaGoalContinuation.resume(input).pipe(Effect.ignore) as Effect.Effect<void>
}
const decode = Schema.decodeUnknownEffect(PlanArtifact.Info)

function brief(item: RayaTask.Agent, reports: readonly Note[], question: string) {
  const evidence = reports.filter((row) => row.kind === "report" || row.kind === "decision").slice(-8)
  const listed = evidence.length
    ? evidence.map((row) => `${row.source} (${new Date(row.time).toISOString()}):\n${row.body}`).join("\n\n")
    : "No reports are available in this conversation. Say so if you cannot answer from evidence. Do not invent figures."
  return [
    "Answer this user follow-up in this worker conversation.",
    "The standing assignment and schedule are unchanged. Do not rewrite them, and do not treat this as a request to run the recurring job now.",
    `Standing assignment:\n${item.objective}`,
    `Recent conversation evidence:\n${listed}`,
    `User question:\n${question}`,
    "If the question is ambiguous about which report or company, ask. Do not invent figures that are not in the evidence.",
  ].join("\n\n")
}

function specialist(item: { role: string; mode?: string }) {
  const mode = item.mode?.trim()
  if (mode) return mode
  if (item.role === "designer") return "designer"
  if (item.role === "coder" || item.role === "code") return "coder"
  return "generalist"
}

function kind(role: string, objective: string) {
  if (role === "briefer" || role === "inbox" || /remind|notify|summary|draft replies/i.test(objective))
    return "notify" as const
  return "code" as const
}

function workspace() {
  return Effect.gen(function* () {
    const mod = yield* Effect.promise(() => import("@/project/instance-store"))
    const store = yield* Effect.serviceOption(mod.Service)
    if (Option.isNone(store)) {
      return yield* new RayaTask.GuardError({
        kind: "unavailable",
        message: "Workspace services are unavailable for this routine.",
      })
    }
    return store.value
  })
}

function open<A, E, R>(dir: string | undefined, effect: Effect.Effect<A, E, R>) {
  const path = dir?.trim()
  if (!path) return effect
  return Effect.gen(function* () {
    const store = yield* workspace()
    yield* Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: () => new RayaTask.GuardError({ message: "Could not create that write folder." }),
    })
    return yield* store.provide({ directory: path }, effect)
  })
}

export namespace RayaTaskRunner {
  type Trigger =
    | { kind: "timer"; selected: Extract<RayaTask.Trigger, { kind: "timer" }> }
    | { kind: "event"; source: string; filter?: string; receivedAt: number }
  type Tasks = ReturnType<typeof RayaTask.make>
  type Runner = {
    tick: (from: number) => Effect.Effect<void>
    fire: (id: string) => Effect.Effect<RayaTask.Run, RayaTask.GuardError | RayaTask.NotFoundError>
    ask: (id: string, question: string) => Effect.Effect<RayaTask.Run, RayaTask.GuardError | RayaTask.NotFoundError>
    settle: (sessionID: SessionID) => Effect.Effect<void>
    park: (sessionID: SessionID, waiting: boolean) => Effect.Effect<void>
    revive: () => Effect.Effect<void>
    announce: (source: string, filter?: string) => Effect.Effect<RayaTask.Run[]>
    tasks: Tasks
    preview: (from: number) => Effect.Effect<RayaTask.Agent[]>
  }

  export function make(input: {
    database?: Database.Interface
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
  }): Runner {
    const tasks = RayaTask.make(input)
    const snapshots = RayaTaskSnapshot.make(input)
    const goals = RayaGoal.make(input)
    const schedule = input.database ? scheduler({ ...input, database: input.database }) : undefined
    const restore = input.database ? recovery({ ...input, database: input.database }) : undefined
    const inbox = input.database ? RayaTaskInbox.make(input.database) : undefined
    const retain = (run: RayaTask.Run) => {
      const item = posted(run)
      if (!inbox || !item) return Effect.void
      return inbox.publish(item).pipe(
        Effect.catch((error) =>
          typeof error === "object" && error !== null && "_tag" in error && error._tag === "RayaTaskInbox.Conflict"
            ? Effect.void
            : Effect.die(error),
        ),
      )
    }

    const seed = Effect.fn("RayaTaskRunner.seed")(function* (item: RayaTask.Agent) {
      const memory = yield* tasks.recall(item.id)
      const chunks = [item.objective]
      if (item.output) {
        chunks.push(
          "Required output (deliver in this run's conversation):\n" + item.output.description,
          "Required acceptance criteria:\n" +
            item.output.criteria
              .map((criterion) => `[${criterion.id}] ${criterion.description}\nVerification: ${criterion.verification}`)
              .join("\n\n"),
          "Report evidence for each criterion by its ID. In the update_goal completion audit, include exactly one requirement per saved criterion, set criterionID to its ID and preserve its description as the requirement text. Do not claim completion when a required criterion is unmet or unverified. If verification requires a person's judgment, request that review. This output contract does not grant permission to send external messages or modify files.",
        )
      }
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

    const check = Effect.fn("RayaTaskRunner.check")(function* (id: string, trigger?: Trigger, follow?: boolean) {
      const item = follow ? yield* tasks.get(id) : yield* tasks.launchable(id)
      if (follow && item.access === undefined)
        return yield* new RayaTask.GuardError({
          kind: "access",
          field: "access",
          message: "Review this older routine's workspace access before starting another run.",
        })
      if (item.dir?.trim()) yield* workspace()
      if (trigger?.kind === "timer") {
        if (!schedule)
          return yield* new RayaTask.GuardError({
            kind: "unavailable",
            message: "The routine occurrence database is unavailable.",
          })
        return { item, trigger: yield* schedule.check(item, trigger.selected) }
      }
      if (trigger?.kind === "event" && !RayaTask.listen(item, trigger.source, trigger.filter)) {
        return yield* new RayaTask.GuardError({ message: "This event no longer matches the routine's schedule." })
      }
      const history = yield* tasks.runsFor(id)
      if (history.some(RayaTask.pending)) {
        return yield* new RayaTask.GuardError({ message: "This agent is already running or waiting on you." })
      }
      if (schedule && (yield* schedule.active(id)).length)
        return yield* new RayaTask.GuardError({
          message: "An earlier scheduled occurrence is still active or needs recovery.",
        })
      return { item, trigger: trigger?.kind === "event" ? trigger : { kind: "manual" as const } }
    })

    const recoverable = Effect.fn("RayaTaskRunner.recoverable")(function* (id: string) {
      if (restore) yield* restore(id)
      return yield* recover(input.storage, id, (record) =>
        Effect.gen(function* () {
          if (record.phase !== "session-created" || !record.sessionID) return false
          const history = yield* tasks.runsFor(id)
          const run = history.find((entry) => entry.id === record.id && entry.sessionID === record.sessionID)
          if (run?.status !== "complete") return false
          const goal = yield* goals.get(record.sessionID)
          return goal?.status === "complete"
        }),
      )
    })

    const fire = Effect.fn("RayaTaskRunner.fire")((id: string, trigger?: Trigger, note?: string) =>
      tasks.enforce(id).pipe(
        Effect.andThen(recoverable(id)),
        Effect.andThen(
          claim(
            input.storage,
            id,
            check(id, trigger, !!note),
            (selected, owner) =>
              Effect.gen(function* () {
                const item = selected.item
                if (selected.trigger.kind === "timer") {
                  if (!schedule)
                    return yield* new RayaTask.GuardError({
                      message: "The routine occurrence database is unavailable.",
                    })
                  yield* schedule.reserve(selected.trigger, owner.id)
                }
                const objective = note ?? (yield* seed(item))
                yield* snapshots.save({
                  version: 1,
                  runID: owner.id,
                  agentID: item.id,
                  at: owner.at,
                  definition: item,
                  objective,
                })
                const created = yield* open(
                  item.dir,
                  input.sessions.create({
                    title: item.name,
                    agent: specialist(item),
                    metadata: {
                      rayaRoutine: {
                        version: selected.trigger.kind === "timer" ? 2 : 1,
                        agentID: item.id,
                        runID: owner.id,
                        scheduleVersion: item.scheduleVersion ?? 1,
                        trigger: selected.trigger,
                      },
                    },
                    model:
                      item.mode || !item.model
                        ? undefined
                        : {
                            providerID: ProviderV2.ID.make(item.model.providerID),
                            id: ModelV2.ID.make(item.model.id),
                          },
                    permission: RayaTask.rules(item),
                  }),
                )
                yield* owner.link(created.id)
                if (selected.trigger.kind === "timer" && schedule)
                  yield* schedule.link(selected.trigger, owner.id, created.id)
                yield* goals.create(
                  created.id,
                  objective,
                  undefined,
                  undefined,
                  undefined,
                  note ? undefined : item.output?.criteria,
                )
                const run: RayaTask.Run = {
                  id: owner.id,
                  agentID: item.id,
                  at: owner.at,
                  sessionID: created.id,
                  status: "running",
                  scheduleVersion: item.scheduleVersion ?? 1,
                  trigger: selected.trigger,
                }
                const stored = yield* tasks.record(run)
                yield* kick({
                  database: input.database,
                  sessionID: created.id,
                  storage: input.storage,
                  sessions: input.sessions,
                }).pipe(Effect.forkDetach)
                return stored
              }),
            (selected) => selected.trigger,
          ),
        ),
      ),
    )

    const park = Effect.fn("RayaTaskRunner.park")(function* (sessionID: SessionID, waiting: boolean) {
      const items = yield* tasks.list()
      for (const item of items) {
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.sessionID === sessionID)
        if (!run || run.status === "complete" || run.status === "error") continue
        if (waiting) {
          if (run.status === "blocked" && run.blockedReason === WAIT) {
            yield* retain(run)
            continue
          }
          yield* tasks.transition(run, { ...run, status: "blocked", blockedReason: WAIT })
          const latest = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
          if (latest) yield* retain(latest)
          continue
        }
        if (run.status !== "blocked" || run.blockedReason !== WAIT) continue
        yield* tasks.transition(run, { ...run, status: "running", blockedReason: undefined })
      }
    })

    const steer = Effect.fn("RayaTaskRunner.steer")(function* (run: RayaTask.Run, note: string) {
      const existing = yield* goals.get(run.sessionID)
      if (!existing || existing.status === "complete") {
        yield* goals.create(run.sessionID, note).pipe(
          Effect.catchTag("RayaGoal.AuditError", (err) => Effect.fail(new RayaTask.GuardError({ message: err.message }))),
          Effect.catchTag("RayaGoal.ExistsError", () =>
            Effect.fail(new RayaTask.GuardError({ message: "This worker is already running another goal." })),
          ),
        )
      } else {
        yield* goals.revise(run.sessionID, note).pipe(
          Effect.catchTag("RayaGoal.AuditError", (err) => Effect.fail(new RayaTask.GuardError({ message: err.message }))),
          Effect.catchTag("RayaGoal.NotFoundError", () =>
            Effect.fail(new RayaTask.GuardError({ message: "This worker's current run could not be steered." })),
          ),
        )
      }
      if (run.status === "blocked" && run.blockedReason === WAIT) yield* park(run.sessionID, false)
      yield* kick({
        database: input.database,
        sessionID: run.sessionID,
        storage: input.storage,
        sessions: input.sessions,
      }).pipe(Effect.forkDetach)
      return run
    })

    const ask = Effect.fn("RayaTaskRunner.ask")(function* (id: string, question: string) {
      const item = yield* tasks.get(id)
      if (item.access === undefined)
        return yield* new RayaTask.GuardError({
          kind: "access",
          field: "access",
          message: "Review this older routine's workspace access before starting another run.",
        })
      const reports = inbox ? (yield* inbox.page(id)).messages : []
      const note = brief(item, reports, question)
      const last = (yield* tasks.runsFor(id)).at(-1)
      if (last && RayaTask.pending(last)) return yield* steer(last, note)
      return yield* fire(id, undefined, note)
    })

    const settle = Effect.fn("RayaTaskRunner.settle")(function* (sessionID: SessionID) {
      const items = yield* tasks.list()
      for (const item of items) {
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.sessionID === sessionID && entry.status === "running")
        if (!run) {
          const done = history.findLast((entry) => entry.sessionID === sessionID && entry.status !== "running")
          if (done) yield* retain(done)
          continue
        }
        const goal = yield* goals.get(sessionID)
        const status =
          goal?.status === "complete"
            ? "complete"
            : goal?.status === "blocked"
              ? "blocked"
              : goal?.status === "paused" || goal?.status === "active"
                ? "running"
                : "error"
        if (status === "running") continue
        const saved = yield* snapshots.find(run.id).pipe(Effect.orDie)
        if (
          saved &&
          (saved.agentID !== run.agentID ||
            saved.at !== run.at ||
            (saved.definition.scheduleVersion ?? 1) !== (run.scheduleVersion ?? 1))
        )
          yield* Effect.die(new Error("Saved startup snapshot does not match run history."))
        const definition = saved?.definition ?? item
        const msgs = yield* input.sessions.messages({ sessionID })
        const cost = msgs.reduce((sum, row) => sum + (row.info.role === "assistant" ? row.info.cost : 0), 0)
        const summary = goal?.blockedReason?.trim() || goal?.audit?.summary?.trim() || ""
        const changed = yield* tasks.transition(run, {
          ...run,
          status,
          blockedReason: goal
            ? goal.blockedReason
            : "No saved goal is available to verify this run's result. Review its conversation and saved instructions before starting more work.",
          outcome: {
            kind: kind(definition.role, definition.objective),
            summary,
            evidence: goal?.audit?.requirements.flatMap((req) => req.evidence.map((ev) => ev.summary)),
            verification: goal?.audit
              ? {
                  at: goal.audit.verifiedAt,
                  requirements: goal.audit.requirements.map((req) => {
                    const criterion = goal.criteria?.find((item) => item.id === req.criterionID)
                    return {
                      criterionID: req.criterionID,
                      requirement: req.requirement,
                      verification: criterion?.verification,
                      required: criterion?.required !== false,
                      passed: req.passed,
                      evidence: req.evidence.map((ev) => ev.summary),
                    }
                  }),
                }
              : undefined,
            cost,
          },
        })
        if (changed && definition.memoryScope === "role" && summary) {
          yield* tasks.append(item.id, summary)
        }
        if (changed && schedule && (status === "complete" || status === "blocked"))
          yield* schedule.settle({ ...run, status, blockedReason: goal?.blockedReason })
        const latest = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
        if (latest) yield* retain(latest)
      }
    })

    const reconcile = Effect.fn("RayaTaskRunner.reconcile")(function* (id: string) {
      if (restore) yield* restore(id)
      if (!schedule) return
      const active = yield* schedule.active(id)
      if (!active.length) return
      const history = yield* tasks.runsFor(id)
      for (const row of active) {
        const run = history.find(
          (run) =>
            run.id === row.claim_id &&
            run.sessionID === row.session_id &&
            run.trigger?.kind === "timer" &&
            run.trigger.id === row.id,
        )
        if (!run || RayaTask.pending(run)) continue
        const goal = yield* goals.get(run.sessionID)
        if (
          (run.status === "complete" && goal?.status === "complete") ||
          (run.status === "blocked" && goal?.status === "blocked")
        )
          yield* schedule.settle(run)
      }
    })

    const revive = Effect.fn("RayaTaskRunner.revive")(function* () {
      const items = yield* tasks.list()
      for (const item of items) {
        yield* reconcile(item.id)
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.status === "running")
        if (!run) continue
        yield* settle(run.sessionID)
        const again = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
        if (again?.status !== "running") continue
        if (schedule && !(yield* schedule.owned(again))) continue
        yield* kick({
          database: input.database,
          sessionID: run.sessionID,
          storage: input.storage,
          sessions: input.sessions,
        }).pipe(Effect.forkDetach)
      }
    })

    const announce = Effect.fn("RayaTaskRunner.announce")(function* (source: string, filter?: string) {
      const receivedAt = Date.now()
      const items = yield* tasks.listenFor(source, filter)
      const runs: RayaTask.Run[] = []
      for (const item of items) {
        const run = yield* fire(item.id, { kind: "event", source, filter, receivedAt }).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (run) runs.push(run)
      }
      return runs
    })

    const tick = (from: number) =>
      (schedule ? schedule.clean() : Effect.void).pipe(
        Effect.andThen(tasks.list()),
        Effect.flatMap((items) =>
          Effect.forEach(
            items,
            (item) =>
              Effect.gen(function* () {
                yield* tasks.enforce(item.id)
                yield* reconcile(item.id)
                if (schedule) {
                  yield* schedule.retire(item.id)
                  yield* schedule.pulse(item.id)
                }
                if (!item.enabled || (item.schedule.kind !== "once" && item.schedule.kind !== "cron")) return undefined
                if (!schedule) return yield* Effect.die(new Error("The routine occurrence database is unavailable."))
                const selected = yield* schedule.prepare(item.id, from)
                if (selected) yield* fire(item.id, { kind: "timer", selected })
                return undefined
              }).pipe(Effect.catch(() => Effect.void)),
            { concurrency: 4, discard: true },
          ),
        ),
      )

    const preview = Effect.fn("RayaTaskRunner.preview")(function* (from: number) {
      const items = (yield* tasks.preview(from)).map((item) => ({ ...item, execution: undefined }))
      return yield* Effect.forEach(
        items,
        (item) =>
          Effect.gen(function* () {
            const active = schedule ? yield* schedule.active(item.id) : []
            if (schedule && active.length) {
              const state =
                active.length > 1 || active.some((row) => schedule.status(row, from) === "recovery")
                  ? "recovery"
                  : schedule.status(active[0], from)
              return {
                ...item,
                nextRun: undefined,
                execution: {
                  state,
                  ...(active.length === 1 && active[0].claim_id ? { runID: active[0].claim_id } : {}),
                  ...(active.length === 1 && active[0].session_id
                    ? { sessionID: SessionID.make(active[0].session_id) }
                    : {}),
                },
                note: [
                  active.some((row) => (row.lease_until ?? 0) <= from)
                    ? "A scheduled occurrence has an expired lease and needs recovery review."
                    : state === "recovery"
                      ? "A scheduled run needs recovery review before more work can start."
                      : state === "starting"
                        ? "A scheduled run is starting."
                        : "A scheduled run is in progress.",
                  item.note,
                ]
                  .filter(Boolean)
                  .join("\n"),
              }
            }
            const execution = yield* inspect(input.storage, item.id)
            if (execution)
              return {
                ...item,
                nextRun: undefined,
                execution,
                note: [
                  execution.state === "starting"
                    ? "A routine is starting."
                    : "An interrupted routine start needs recovery review.",
                  item.note,
                ]
                  .filter(Boolean)
                  .join("\n"),
              }
            if (!schedule) return item
            const history = yield* tasks.runsFor(item.id)
            if (!item.enabled || RayaTask.unzoned(item.schedule) || history.some(RayaTask.pending)) return item
            const pending = yield* schedule.queued(item.id, item.scheduleVersion ?? 1)
            const queued = pending.find((row) => !RayaTask.recorded(item, history, row.scheduled_at))
            return queued
              ? {
                  ...item,
                  nextRun: queued.scheduled_at,
                  note: ["A previously selected occurrence is queued for startup.", item.note]
                    .filter(Boolean)
                    .join("\n"),
                }
              : item
          }),
        { concurrency: 4 },
      )
    })

    return {
      tick,
      preview,
      fire: fire as Runner["fire"],
      ask: ask as Runner["ask"],
      settle: settle as Runner["settle"],
      park: park as Runner["park"],
      revive: revive as Runner["revive"],
      announce: announce as Runner["announce"],
      tasks,
    }
  }

  export function lifecycle(input: Parameters<typeof subscribe>[0]) {
    return Effect.gen(function* () {
      const state = yield* InstanceState.make(() => subscribe(input))
      return () => InstanceState.get(state)
    })
  }

  export function subscribe(input: {
    database?: Database.Interface
    bus: Pick<Bus.Interface, "subscribeCallback">
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
  }) {
    const runner = make(input)
    return Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const scope = yield* Effect.scope
      yield* Effect.acquireRelease(
        input.bus.subscribeCallback(KiloSession.Event.TurnClose, (event) => {
          const sid = event.properties.sessionID
          bridge.fork(
            runner.settle(sid).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.sync(() => log.error("task settle failed", { sessionID: sid, err: Cause.squash(cause) })),
              ),
              Effect.forkIn(scope),
            ),
          )
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const asked = new Set(["permission.asked", "question.asked"])
          const replied = new Set(["permission.replied", "question.replied", "question.rejected"])
          const listener = (event: GlobalEvent) => {
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
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.sync(() => log.error("task park failed", { sessionID: sid, err: Cause.squash(cause) })),
                ),
                Effect.forkIn(scope),
              ),
            )
          }
          GlobalBus.on("event", listener)
          return listener
        }),
        (listener) => Effect.sync(() => GlobalBus.off("event", listener)),
      )
      yield* runner
        .revive()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("task revive failed", { err: Cause.squash(cause) })),
          ),
        )
      const tick = Effect.gen(function* () {
        yield* runner.tick(Date.now())
      })
      yield* poll(tick, (cause) => log.error("routine poll failed", { err: Cause.squash(cause) })).pipe(
        Effect.forkScoped,
      )
    })
  }
}
