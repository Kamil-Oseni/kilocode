import { mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Cause, Duration, Effect, Exit, Option, Schema, Semaphore } from "effect"
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
import {
  RayaTaskDelegation,
  ceiling,
  credited,
  prompt,
  scope,
  Invalid,
  type Conflict,
  type Request as Ask,
  type Record as Errand,
} from "./delegation"
import { claim } from "./claim"
import { record as ContinuationRecord } from "./continuation"
import { inspect, recover } from "./recovery"
import { stopped } from "./owner"
import { hold } from "./hold"
import { poll } from "./poll"
import { InstanceState } from "@/effect/instance-state"
import { capture } from "@/kilocode/instance"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Database } from "@opencode-ai/core/database/database"
import { scheduler } from "./scheduler"
import { RayaTaskQueue } from "./queue"
import { reconcile as recovery } from "./reconcile"
import { RayaTaskSnapshot } from "./snapshot"
import { RayaTaskOrganization } from "./organization"
import { make as reservation } from "./reservation"
import { RayaContactMessenger } from "@/kilocode/contact/raya"
import * as Log from "@opencode-ai/core/util/log"
import { BackgroundProcess } from "@/kilocode/background-process"
import { lineage } from "@/kilocode/background-process/lifecycle"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import type { PtyArchive } from "@/kilocode/pty/archive"
import { RayaTaskExecution } from "./execution"
import { scheduler as admission } from "./admission"
import { TaskRetirement } from "@/kilocode/goal/stop-receipt"

const WAIT = "waiting on you"

const log = Log.create({ service: "raya-task-runner" })
const inventory = () => ({ retained: new Set<string>(), gate: Semaphore.makeUnsafe(1), ready: false })
const inventories = new WeakMap<Storage.Interface, WeakMap<Database.Interface, ReturnType<typeof inventory>>>()
const standalone = new WeakMap<Storage.Interface, ReturnType<typeof inventory>>()

function registry(storage: Storage.Interface, database?: Database.Interface) {
  if (!database) {
    const current = standalone.get(storage) ?? inventory()
    standalone.set(storage, current)
    return current
  }
  const graphs = inventories.get(storage) ?? new WeakMap<Database.Interface, ReturnType<typeof inventory>>()
  const current = graphs.get(database) ?? inventory()
  graphs.set(database, current)
  inventories.set(storage, graphs)
  return current
}
const known = (err: unknown) => err instanceof RayaTask.GuardError || err instanceof RayaTask.NotFoundError

type Organization = { id: string; name: string; revision: number; policy?: string; budget?: number }

function policy(objective: string, organization?: Organization) {
  if (!organization?.policy) return objective
  return [
    `Organization policy for ${organization.name} (${organization.id}, revision ${organization.revision}):`,
    organization.policy,
    "This policy constrains this delegated request. It does not grant tools, filesystem access, network access, or approval authority.",
    objective,
  ].join("\n\n")
}

function kick(
  input: {
    database?: Database.Interface
    sessionID: SessionID
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
  },
  run: RayaTask.Run,
): Effect.Effect<void> {
  return RayaGoalContinuation.accepted(input, run).pipe(Effect.asVoid) as Effect.Effect<void>
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

function plain(value: string, max = 512) {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
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

function absent(id: string): RayaTask.Agent {
  return {
    id,
    name: "Unavailable worker",
    role: "unavailable",
    objective: "This worker is no longer available.",
    capabilities: [],
    memoryScope: "session",
    schedule: { kind: "manual" },
    enabled: false,
    createdAt: 0,
    updatedAt: 0,
    access: "brief",
  }
}

function open<A, E, R>(dir: string | undefined, effect: Effect.Effect<A, E, R>) {
  const path = dir?.trim()
  if (!path) return effect
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: () => new RayaTask.GuardError({ message: "Could not create that write folder." }),
    })
    const ctx = capture()
    if (ctx && FSUtil.resolve(ctx.directory) === FSUtil.resolve(path)) return yield* effect
    const store = yield* workspace()
    return yield* store.provide({ directory: path }, effect)
  })
}

export namespace RayaTaskRunner {
  type Review = {
    sessionID: SessionID
    requestID: string
    permission: string
    patterns: string[]
    callID?: string
  }
  type Trigger =
    | { kind: "timer"; selected: Extract<RayaTask.Trigger, { kind: "timer" }> }
    | { kind: "event"; source: string; filter?: string; receivedAt: number }
  type Tasks = ReturnType<typeof RayaTask.make>
  type GoalStop = {
    prepare: (sessionID: SessionID) => Effect.Effect<TaskRetirement, RayaTask.GuardError>
    finish: (sessionID: SessionID, pin: TaskRetirement, finished: boolean) => Effect.Effect<void, RayaTask.GuardError>
  }
  type Runner = {
    tick: (from: number) => Effect.Effect<void, RayaTask.GuardError>
    fire: (id: string) => Effect.Effect<RayaTask.Run, RayaTask.GuardError | RayaTask.NotFoundError>
    ask: (
      id: string,
      question: string,
      opts?: { defer?: boolean; bind?: { source: string; sessionID: SessionID } },
    ) => Effect.Effect<RayaTask.Run, RayaTask.GuardError | RayaTask.NotFoundError>
    dispatch: (id: string) => Effect.Effect<Note | undefined, RayaTask.GuardError | RayaTask.NotFoundError>
    resume: (sessionID: SessionID) => Effect.Effect<void, unknown>
    reviewReply: (sessionID: SessionID, intent: string) => Effect.Effect<void, unknown>
    delegate: (input: Ask) => Effect.Effect<Errand, RayaTask.GuardError | RayaTask.NotFoundError | Invalid | Conflict>
    stop: (id: string) => Effect.Effect<Errand, RayaTask.GuardError | RayaTask.NotFoundError | Invalid>
    stopMembers: (id: string, members: readonly string[]) => Effect.Effect<void, unknown>
    recoverStops: () => Effect.Effect<void, unknown>
    settle: (sessionID: SessionID) => Effect.Effect<void, RayaTask.GuardError>
    stopGoal: <A, E, R>(
      body: (tasks: GoalStop) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RayaTask.GuardError, R>
    resolve: (
      id: string,
      runID: string,
    ) => Effect.Effect<
      { agentID: string; runID: string; sessionID?: SessionID; closedAt: number; reason: string },
      RayaTask.GuardError | RayaTask.NotFoundError
    >
    park: (sessionID: SessionID, waiting: boolean) => Effect.Effect<void, RayaTask.GuardError>
    revive: () => Effect.Effect<void, unknown>
    announce: (source: string, filter?: string) => Effect.Effect<RayaTask.Run[]>
    tasks: Tasks
    preview: (from: number) => Effect.Effect<RayaTask.Agent[]>
  }

  function build(input: {
    database?: Database.Interface
    storage: Storage.Interface
    sessions: Pick<Session.Interface, "create" | "get" | "messages" | "children">
    halt?: (sessionID: SessionID) => Effect.Effect<void>
    pty?: PtyArchive.Interface
    continuation?: (run: RayaTask.Run) => Effect.Effect<void>
  }): { runner: Runner; events: Pick<Runner, "settle" | "park"> } {
    const refuse = () => new RayaTask.GuardError({ message: "Routine scheduler admission is closed." })
    const intake = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      admission.track(initialize.pipe(Effect.andThen(body)), refuse)
    const transfer = hold(input.storage)
    const tasks = RayaTask.make(input)
    const execution = RayaTaskExecution.make(input.storage)
    const snapshots = RayaTaskSnapshot.make(input)
    const goals = RayaGoal.make(input)
    const reservations = input.database ? reservation(input.database) : undefined
    const schedule = input.database ? scheduler({ ...input, database: input.database }) : undefined
    const restore = input.database ? recovery({ ...input, database: input.database }) : undefined
    const inbox = input.database ? RayaTaskInbox.make(input.database) : undefined
    const organizations = input.database ? RayaTaskOrganization.make(input.database, tasks, input.storage) : undefined
    // Lazy directory/tool runners share the actual injected services' cutoff; timestamps never infer ownership.
    const cold = registry(input.storage, input.database)
    const retained = cold.retained
    const authority = Effect.fn("RayaTaskRunner.delegatedAuthority")(function* (row: Errand, run: RayaTask.Run) {
      if (row.childRunID !== run.id || row.sessionID !== run.sessionID || row.recipientID !== run.agentID)
        return yield* new RayaTask.GuardError({ message: "This assignment no longer owns the worker's original run." })
      const sender = yield* tasks.get(row.senderID)
      const recipient = yield* tasks.get(row.recipientID)
      const snapshot = yield* snapshots.find(run.id)
      const fields = (item: RayaTask.Agent) => ({
        role: item.role,
        access: item.access,
        tools: item.tools,
        dir: item.dir,
        paths: item.paths,
        capabilities: item.capabilities,
      })
      if (
        !recipient.enabled ||
        sender.access === undefined ||
        recipient.access === undefined ||
        !snapshot ||
        snapshot.agentID !== recipient.id ||
        snapshot.at !== run.at ||
        (snapshot.definition.scheduleVersion ?? 1) !== (run.scheduleVersion ?? 1) ||
        !isDeepStrictEqual(fields(snapshot.definition), fields(recipient)) ||
        scope(sender, recipient) !== row.workspace ||
        (sender.dir?.trim() && recipient.dir?.trim() && row.workspace === undefined)
      )
        return yield* new RayaTask.GuardError({
          message: "This assignment's worker access changed. Review it before continuing.",
        })
      if (organizations && ((yield* organizations.stopped(sender.id)) || (yield* organizations.stopped(recipient.id))))
        return yield* new RayaTask.GuardError({ message: "This worker's organization is stopping or archived." })
      const session = yield* input.sessions.get(run.sessionID)
      const rules = yield* open(
        recipient.dir,
        Effect.gen(function* () {
          const worktree = recipient.dir ? (yield* InstanceState.context).worktree : undefined
          return RayaTask.rules(ceiling(sender, recipient), worktree)
        }),
      )
      if (!isDeepStrictEqual(session.permission, rules))
        return yield* new RayaTask.GuardError({
          message: "This worker's access changed. Review the assignment before continuing.",
        })
      const goal = yield* goals.get(run.sessionID)
      if (!goal || goal.budget?.modelCost !== (row.budget ?? snapshot.definition.budget))
        return yield* new RayaTask.GuardError({
          message: "This assignment's budget changed. Review it before continuing.",
        })
      if (row.parentRunID) {
        const parent = (yield* tasks.runsFor(sender.id)).find((item) => item.id === row.parentRunID)
        if (!RayaTask.pending(parent))
          return yield* new RayaTask.GuardError({ message: "The original requesting run was removed or stopped." })
      }
    })
    const errands = input.database
      ? RayaTaskDelegation.make(input.database, organizations?.authorize, organizations?.shares, {
          storage: input.storage,
          receipt: execution.receipt,
          reviewed: execution.reviewed,
          guard: authority,
        })
      : undefined
    const initialize = cold.gate.withPermit(
      Effect.gen(function* () {
        if (cold.ready) return
        if (errands)
          for (const item of yield* tasks.list()) for (const row of yield* errands.held(item.id)) retained.add(row.id)
        cold.ready = true
      }).pipe(Effect.orDie),
    )
    const assignment = Effect.fn("RayaTaskRunner.assignment")(function* (
      run: RayaTask.Run,
      identity: typeof ContinuationRecord.Type,
    ) {
      const row = errands ? yield* errands.bySession(run.sessionID) : undefined
      if (!identity.delegationID && !row) return undefined
      if (
        !errands ||
        !row ||
        identity.delegationID !== row.id ||
        identity.agentID !== run.agentID ||
        identity.runID !== run.id ||
        identity.scheduleVersion !== (run.scheduleVersion ?? 1) ||
        !isDeepStrictEqual(identity.trigger, run.trigger) ||
        identity.organizationID !== row.organizationID ||
        identity.organizationRevision !== row.organizationRevision
      )
        return yield* new RayaTask.GuardError({ message: "This worker reply no longer has its original assignment." })
      yield* authority(row, run)
      return row
    })
    const turn = (run: RayaTask.Run) =>
      Effect.gen(function* () {
        yield* transfer.check()
        const row = errands ? yield* errands.bySession(run.sessionID) : undefined
        const session = yield* input.sessions.get(run.sessionID)
        const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        if (row || identity?.delegationID) {
          if (!identity)
            return yield* new RayaTask.GuardError({ message: "This assignment's saved worker identity changed." })
          const current = yield* assignment(run, identity)
          if (
            !current ||
            !errands ||
            current.state !== "running" ||
            (current.deadline !== undefined && current.deadline <= Date.now()) ||
            !(yield* errands.authorize(current))
          )
            return yield* new RayaTask.GuardError({ message: "This assignment can no longer continue." })
          const latest = (yield* tasks.runsFor(current.recipientID)).find((item) => item.id === run.id)
          const goal = yield* goals.get(run.sessionID)
          if (
            !latest ||
            latest.agentID !== run.agentID ||
            latest.sessionID !== run.sessionID ||
            latest.at !== run.at ||
            (latest.scheduleVersion ?? 1) !== (run.scheduleVersion ?? 1) ||
            !isDeepStrictEqual(latest.trigger, run.trigger) ||
            latest.status !== "running" ||
            goal?.status !== "active"
          )
            return
        }
        yield* transfer.check()
        // Native preparation remains protected by its caller; every model entry,
        // including inline delegation recovery, must restore cancellation.
        return yield* (
          input.continuation?.(run) ??
          kick(
            {
              database: input.database,
              sessionID: run.sessionID,
              storage: input.storage,
              sessions: input.sessions,
            },
            run,
          )
        ).pipe(Effect.interruptible)
      })
    const LATE = "This request timed out. It was not completed."
    const affiliation = Effect.fn("RayaTaskRunner.affiliation")(function* (id: string) {
      if (!organizations) return undefined
      const page = yield* organizations
        .memberships(id, { limit: 2 })
        .pipe(
          Effect.mapError(
            (err) =>
              new RayaTask.GuardError({ message: `Could not verify this worker's organization: ${err.message}` }),
          ),
        )
      if (page.items.length !== 1 || page.next) return undefined
      const item = page.items[0]
      return {
        id: item.id,
        name: item.name,
        revision: item.revision,
        policy: item.policy,
        budget: item.budget,
      } satisfies Organization
    })
    const current = (run: RayaTask.Run) =>
      tasks
        .runsFor(run.agentID)
        .pipe(
          Effect.map((rows) =>
            rows.some((row) => row.id === run.id && row.sessionID === run.sessionID && row.status === "running"),
          ),
        )
    const continueRun = Effect.fn("RayaTaskRunner.continueRun")(function* (run: RayaTask.Run) {
      yield* intake(
        Effect.gen(function* () {
          yield* transfer.check()
          if (!(yield* current(run))) return
          const permit = yield* execution.acquire(run)
          if (!permit) return
          yield* admission.observe(execution.enter(run, turn(run).pipe(Effect.andThen(() => retirement(run)))), known)
        }),
      )
    })
    const launch = (run: RayaTask.Run) =>
      admission.fork(
        Effect.gen(function* () {
          yield* transfer.check()
          if (!(yield* current(run))) return Effect.void
          const permit = yield* execution.acquire(run)
          if (!permit) return Effect.void
          return admission
            .observe(execution.enter(run, turn(run).pipe(Effect.andThen(() => retirement(run)))), known)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error("routine continuation failed", {
                    sessionID: run.sessionID,
                    err: Cause.squash(cause),
                  }),
                ),
              ),
            )
        }),
        refuse,
      )
    const sync = Effect.fn("RayaTaskRunner.syncDelegationBudget")(function* (row: Errand) {
      if (!row.parentRunID) return
      const history = yield* tasks.runsFor(row.senderID)
      const parent = history.find((run) => run.id === row.parentRunID)
      if (!parent) return
      const result = yield* goals
        .delegated(parent.sessionID, parent.id)
        .pipe(Effect.catchTag("RayaGoal.NotFoundError", () => Effect.succeed(undefined)))
      if (!result?.resumed) return
      yield* continueRun(parent)
    })
    const spent = Effect.fn("RayaTaskRunner.delegationSpend")(function* (row: Errand) {
      if (!row.sessionID) return undefined
      const goal = yield* goals.get(row.sessionID)
      return goal?.usage.cost
    })
    const drop = (id: string, sid: SessionID | undefined, rid: string | undefined, reason: string) =>
      Effect.gen(function* () {
        const history = yield* tasks.runsFor(id)
        const run = history.find((row) => (rid && row.id === rid) || (sid && row.sessionID === sid))
        if (!run) return
        if (!RayaTask.pending(run)) return run.status === "error" && run.blockedReason === reason ? run : undefined
        const next = { ...run, status: "error" as const, blockedReason: reason }
        if (!(yield* tasks.transition(run, next))) return
        return next
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            log.error("delegated run drop failed", { err })
            return undefined
          }),
        ),
      )
    const lapse = Effect.fn("RayaTaskRunner.lapse")(function* (from: number) {
      if (!errands) return
      const rows = yield* errands.overdue(from)
      for (const row of rows) {
        const recipient = yield* tasks
          .get(row.recipientID)
          .pipe(Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(undefined)))
        if (!recipient) continue
        const failed = yield* errands.finish(row.id, "failed", recipient, undefined, yield* spent(row), LATE).pipe(
          Effect.catchTag("RayaTaskDelegation.Conflict", () => Effect.void),
          Effect.catchTag("RayaTaskDelegation.Invalid", (err) =>
            Effect.sync(() => log.error("delegation timeout failed", { err })),
          ),
        )
        if (failed)
          yield* sync(failed).pipe(
            Effect.catch((err) => Effect.sync(() => log.error("delegation budget sync failed", { err }))),
          )
        yield* drop(row.recipientID, row.sessionID, row.childRunID, LATE)
        if (!row.sessionID || !input.halt) continue
        yield* input
          .halt(row.sessionID)
          .pipe(Effect.catch((err) => Effect.sync(() => log.error("timed out session stop failed", { err }))))
      }
    })
    const retain = Effect.fn("RayaTaskRunner.retain")(function* (run: RayaTask.Run) {
      const item = posted(run)
      if (!inbox || !item) return
      const kids = errands ? yield* errands.byRun(run.id) : []
      const names = new Map<string, string>()
      for (const kid of kids) {
        if (names.has(kid.recipientID)) continue
        const found = yield* tasks
          .get(kid.recipientID)
          .pipe(Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(undefined)))
        names.set(kid.recipientID, found?.name ?? kid.recipientID)
      }
      const extra = credited(kids, (id) => names.get(id) ?? id)
      const body = extra.length ? [item.body, ...extra].join("\n").slice(0, 8000) : item.body
      yield* inbox
        .publish({ ...item, body })
        .pipe(
          Effect.catch((error) =>
            typeof error === "object" && error !== null && "_tag" in error && error._tag === "RayaTaskInbox.Conflict"
              ? Effect.void
              : Effect.die(error),
          ),
        )
    })

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
      if (item.dir?.trim() && !item.paths) {
        chunks.push(`Write new files only in ${item.dir.trim()}. You may read from anywhere else.`)
      }
      if (item.paths) {
        const roots = item.paths.grants.map(
          (grant) => `- ${grant.access === "write" ? "Read and write" : "Read only"}: ${grant.path}`,
        )
        chunks.push(
          [
            `Your primary write folder is ${item.dir}.`,
            "Additional folder access:",
            ...roots,
            "Command tools and workspace-wide code navigation are unavailable while additional folder limits are active. Use file tools so these boundaries can be enforced.",
          ].join("\n"),
        )
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
      yield* transfer.check()
      if (organizations && (yield* organizations.stopped(id)))
        return yield* new RayaTask.GuardError({ message: "This worker's organization is stopping or archived." })
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
      yield* transfer.check()
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

    const fire = Effect.fn("RayaTaskRunner.fire")(
      (
        id: string,
        trigger?: Trigger,
        note?: string,
        opts?: {
          follow?: boolean
          view?: Pick<RayaTask.Agent, "role" | "access" | "tools">
          defer?: boolean
          guard?: Effect.Effect<Organization | undefined, RayaTask.GuardError>
          runID?: string
          delegationID?: string
          budget?: RayaGoal.Budget
          bind?: { source: string; sessionID: SessionID }
        },
      ) =>
        Effect.gen(function* () {
          yield* transfer.check()
          for (const run of yield* tasks.runsFor(id)) {
            const goal = yield* goals.get(run.sessionID)
            if (goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined)
              return yield* new RayaTask.GuardError({
                message: "Review the interrupted worker reply before starting more work.",
              })
          }
        }).pipe(
          Effect.andThen(tasks.enforce(id)),
          Effect.andThen(recoverable(id)),
          Effect.andThen(
            claim(
              input.storage,
              id,
              check(id, trigger, opts?.follow ?? !!note).pipe(
                Effect.flatMap((selected) =>
                  (opts?.guard ?? affiliation(id)).pipe(Effect.map((organization) => ({ selected, organization }))),
                ),
              ),
              (admitted, owner) =>
                Effect.gen(function* () {
                  const item = admitted.selected.item
                  if (organizations && (yield* organizations.stopped(item.id)))
                    return yield* new RayaTask.GuardError({
                      message: "This worker's organization is stopping or archived.",
                    })
                  if (admitted.selected.trigger.kind === "timer") {
                    if (!schedule)
                      return yield* new RayaTask.GuardError({
                        message: "The routine occurrence database is unavailable.",
                      })
                    yield* schedule.reserve(admitted.selected.trigger, owner.id)
                  }
                  const objective = policy(note ?? (yield* seed(item)), admitted.organization)
                  yield* snapshots.save({
                    version: 2,
                    runID: owner.id,
                    agentID: item.id,
                    at: owner.at,
                    definition: item,
                    objective,
                    ...(admitted.organization?.policy
                      ? {
                          organizationPolicy: {
                            organizationID: admitted.organization.id,
                            organizationRevision: admitted.organization.revision,
                            sha256: createHash("sha256").update(admitted.organization.policy, "utf8").digest("hex"),
                          },
                        }
                      : {}),
                  })
                  const created = yield* open(
                    item.dir,
                    Effect.gen(function* () {
                      const worktree = item.dir ? (yield* InstanceState.context).worktree : undefined
                      return yield* input.sessions.create({
                        title: item.name,
                        agent: specialist(item),
                        metadata: {
                          rayaRoutine: {
                            version: admitted.selected.trigger.kind === "timer" ? 2 : 1,
                            agentID: item.id,
                            runID: owner.id,
                            scheduleVersion: item.scheduleVersion ?? 1,
                            trigger: admitted.selected.trigger,
                            ...(opts?.delegationID ? { delegationID: opts.delegationID } : {}),
                            ...(item.budget ? { budget: item.budget } : {}),
                            ...(admitted.organization
                              ? {
                                  organizationID: admitted.organization.id,
                                  organizationRevision: admitted.organization.revision,
                                }
                              : {}),
                          },
                        },
                        model:
                          item.mode || !item.model
                            ? undefined
                            : {
                                providerID: ProviderV2.ID.make(item.model.providerID),
                                id: ModelV2.ID.make(item.model.id),
                              },
                        permission: RayaTask.rules({ ...item, ...opts?.view }, worktree),
                      })
                    }),
                  )
                  yield* transfer.check()
                  yield* owner.link(created.id)
                  if (reservations)
                    yield* reservations
                      .link(owner.id, created.id)
                      .pipe(
                        Effect.mapError((err) => new RayaTask.GuardError({ kind: "conflict", message: err.message })),
                      )
                  if (admitted.selected.trigger.kind === "timer" && schedule)
                    yield* schedule.link(admitted.selected.trigger, owner.id, created.id)
                  yield* goals.create(
                    created.id,
                    objective,
                    undefined,
                    undefined,
                    undefined,
                    note ? undefined : item.output?.criteria,
                    opts?.budget ?? (item.budget ? { modelCost: item.budget } : undefined),
                    opts?.follow || opts?.delegationID ? "reply" : undefined,
                  )
                  const run: RayaTask.Run = {
                    id: owner.id,
                    agentID: item.id,
                    at: owner.at,
                    sessionID: created.id,
                    status: "running",
                    scheduleVersion: item.scheduleVersion ?? 1,
                    trigger: admitted.selected.trigger,
                  }
                  const stored = yield* tasks.record(run)
                  if (opts?.bind && inbox) yield* inbox.move(item.id, opts.bind.source, opts.bind.sessionID, created.id)
                  if (!opts?.defer) yield* launch(stored)
                  return stored
                }),
              (admitted) => admitted.selected.trigger,
              undefined,
              undefined,
              opts?.runID && opts.delegationID
                ? { runID: opts.runID, delegationID: opts.delegationID }
                : opts?.bind
                  ? { source: opts.bind.source, sessionID: opts.bind.sessionID }
                  : undefined,
              (admitted, owner) => {
                const item = admitted.selected.item
                if (opts?.delegationID || !item.budget || !admitted.organization || !reservations) return Effect.void
                return reservations
                  .reserve({
                    runID: owner.id,
                    agentID: item.id,
                    organizationID: admitted.organization.id,
                    organizationRevision: admitted.organization.revision,
                    budget: item.budget,
                  })
                  .pipe(
                    Effect.asVoid,
                    Effect.mapError((err) => new RayaTask.GuardError({ kind: "conflict", message: err.message })),
                  )
              },
            ),
          ),
        ),
    )

    const park = Effect.fn("RayaTaskRunner.park")(function* (sessionID: SessionID, waiting: boolean) {
      const items = yield* tasks.list()
      for (const item of items) {
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.sessionID === sessionID)
        if (!run) continue
        if (!waiting) {
          const row = errands ? yield* errands.bySession(sessionID) : undefined
          const session = yield* input.sessions.get(sessionID)
          const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
            Effect.orElseSucceed(() => undefined),
          )
          if (row || identity?.delegationID) {
            if (
              !identity ||
              !errands ||
              (run.status !== "running" && !(run.status === "blocked" && run.blockedReason === WAIT))
            )
              return yield* new RayaTask.GuardError({ message: "This assignment can no longer continue." })
            const current = yield* assignment(run, identity)
            if (!current)
              return yield* new RayaTask.GuardError({ message: "This assignment's saved worker identity changed." })
            const goal = yield* goals.get(sessionID)
            if (
              goal?.status !== "active" ||
              (goal.replyRecovery && goal.replyRecovery.reviewedAt === undefined) ||
              (yield* execution.authorized(run)) !== true
            )
              return yield* new RayaTask.GuardError({ message: "This worker needs recovery review before continuing." })
            yield* errands.resume(current.id, run.id, sessionID)
            const resumed = yield* assignment(run, identity)
            if (
              !resumed ||
              resumed.state !== "running" ||
              (resumed.deadline !== undefined && resumed.deadline <= Date.now()) ||
              !(yield* errands.authorize(resumed)) ||
              (yield* execution.authorized(run)) !== true
            )
              return yield* new RayaTask.GuardError({ message: "This assignment can no longer continue." })
            const latest = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
            if (
              !latest ||
              (latest.status !== "running" && !(latest.status === "blocked" && latest.blockedReason === WAIT))
            )
              return yield* new RayaTask.GuardError({
                message: "This worker was stopped before the answer could continue.",
              })
          }
        }
        if (run.status === "complete" || run.status === "error") continue
        if (waiting) {
          if (run.status === "blocked" && run.blockedReason === WAIT) {
            yield* retain(run)
            yield* close(run)
            continue
          }
          yield* tasks.transition(run, { ...run, status: "blocked", blockedReason: WAIT })
          const latest = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
          if (latest) {
            yield* retain(latest)
            yield* close(latest)
          }
          continue
        }
        if (run.status !== "blocked" || run.blockedReason !== WAIT) continue
        if (!(yield* tasks.transition(run, { ...run, status: "running", blockedReason: undefined })))
          return yield* new RayaTask.GuardError({ message: "This worker changed before the answer could continue." })
      }
    })

    const steer = Effect.fn("RayaTaskRunner.steer")(function* (run: RayaTask.Run, note: string, defer?: boolean) {
      const existing = yield* goals.get(run.sessionID)
      if (!existing || existing.status === "complete") {
        yield* goals.create(run.sessionID, note, undefined, undefined, undefined, undefined, undefined, "reply").pipe(
          Effect.catchTag("RayaGoal.AuditError", (err) =>
            Effect.fail(new RayaTask.GuardError({ message: err.message })),
          ),
          Effect.catchTag("RayaGoal.ExistsError", () =>
            Effect.fail(new RayaTask.GuardError({ message: "This worker is already running another goal." })),
          ),
        )
      } else {
        yield* goals.revise(run.sessionID, note).pipe(
          Effect.catchTag("RayaGoal.AuditError", (err) =>
            Effect.fail(new RayaTask.GuardError({ message: err.message })),
          ),
          Effect.catchTag("RayaGoal.NotFoundError", () =>
            Effect.fail(new RayaTask.GuardError({ message: "This worker's current run could not be steered." })),
          ),
        )
      }
      if (run.status === "blocked" && run.blockedReason === WAIT) yield* park(run.sessionID, false)
      if (!defer) yield* launch(run)
      return run
    })

    const ask = Effect.fn("RayaTaskRunner.ask")(function* (
      id: string,
      question: string,
      opts?: { defer?: boolean; bind?: { source: string; sessionID: SessionID } },
    ) {
      yield* transfer.check()
      if (organizations && (yield* organizations.stopped(id)))
        return yield* new RayaTask.GuardError({ message: "This worker's organization is stopping or archived." })
      const item = yield* tasks.get(id)
      for (const run of yield* tasks.runsFor(id)) {
        const goal = yield* goals.get(run.sessionID)
        if (goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined)
          return yield* new RayaTask.GuardError({
            message: "Review the interrupted worker reply before sending more work.",
          })
      }
      if (item.access === undefined)
        return yield* new RayaTask.GuardError({
          kind: "access",
          field: "access",
          message: "Review this older routine's workspace access before starting another run.",
        })
      const reports = inbox ? (yield* inbox.page(id)).messages : []
      const note = brief(item, reports, question)
      const last = (yield* tasks.runsFor(id)).at(-1)
      if (last && RayaTask.pending(last)) {
        const row = errands ? yield* errands.bySession(last.sessionID) : undefined
        if (row && errands) {
          const session = yield* input.sessions.get(last.sessionID)
          const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
            Effect.mapError(() => new RayaTask.GuardError({ message: "This worker's saved run identity is invalid." })),
          )
          yield* assignment(last, identity)
          if (
            (row.state !== "running" && row.state !== "needs_input") ||
            (row.deadline !== undefined && row.deadline <= Date.now()) ||
            !(yield* errands.authorize(row))
          )
            return yield* new RayaTask.GuardError({ message: "This assignment can no longer accept a response." })
          const run = yield* steer(last, note, true)
          yield* authority(row, run)
          const current = yield* errands.resume(row.id, run.id, run.sessionID)
          if (
            current.state !== "running" ||
            (current.deadline !== undefined && current.deadline <= Date.now()) ||
            !(yield* errands.authorize(current))
          )
            return yield* new RayaTask.GuardError({
              message: "This assignment changed before the response could start.",
            })
          if (!opts?.defer) yield* launch(run)
          return run
        }
        return yield* steer(last, note, opts?.defer)
      }
      return yield* fire(id, undefined, note, { follow: true, defer: opts?.defer, bind: opts?.bind })
    })
    const dispatch = Effect.fn("RayaTaskRunner.dispatch")(function* (id: string) {
      yield* transfer.check()
      if (!inbox)
        return yield* new RayaTask.GuardError({
          kind: "unavailable",
          message: "Routine conversations are unavailable without the local database.",
        })
      const waiting = yield* inbox.pending(id)
      if (!waiting) return undefined
      const history = yield* tasks.runsFor(id)
      const active = history.findLast(RayaTask.pending)
      if (active && !(active.status === "blocked" && active.blockedReason === WAIT)) return undefined
      const run = yield* ask(id, waiting.body, { defer: true })
      const saved = yield* inbox.attach(id, waiting.source, run.sessionID)
      yield* launch(run)
      return saved
    })
    const resume: Runner["resume"] = Effect.fn("RayaTaskRunner.resume")(function* (sessionID: SessionID) {
      yield* transfer.check()
      const items = yield* tasks.list()
      const active = yield* Effect.forEach(items, (item) => tasks.runsFor(item.id), { concurrency: 1 })
      const goal = yield* goals.get(sessionID)
      const reviewed =
        goal?.replyRecovery?.reviewedAt !== undefined &&
        goal.status === "active" &&
        goal.replyRecovery.reviewIntent === goal.intent &&
        (goal.dispatch?.id === goal.replyRecovery.dispatchID || goal.dispatch?.intent === goal.intent)
      const prior = active.flat().find((run) => run.sessionID === sessionID)
      if (reviewed && prior) {
        const session = yield* input.sessions.get(sessionID)
        const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
          Effect.mapError(
            () =>
              new RayaTask.GuardError({
                message: "This reviewed worker reply no longer has its original run identity.",
              }),
          ),
        )
        if (
          identity.runID !== prior.id ||
          identity.agentID !== prior.agentID ||
          (identity.trigger.kind === "timer" && (identity.version !== 2 || !schedule)) ||
          identity.scheduleVersion !== (prior.scheduleVersion ?? 1) ||
          !isDeepStrictEqual(identity.trigger, prior.trigger) ||
          (prior.status !== "running" && prior.status !== "blocked")
        )
          return yield* new RayaTask.GuardError({
            message: "This reviewed reply cannot resume its original run safely.",
          })
        const row = yield* assignment(prior, identity)
        const pending = inbox ? yield* inbox.stranded(identity.agentID) : undefined
        if (pending?.sessionID !== sessionID || pending.source !== goal!.replyRecovery!.source) {
          const source = inbox
            ? (yield* inbox.page(identity.agentID)).messages.find((row) => row.source === goal!.replyRecovery!.source)
            : undefined
          if (
            prior.status === "running" &&
            source?.sessionID === sessionID &&
            source.kind === "user" &&
            goal!.dispatch?.intent === goal!.intent &&
            (goal!.dispatch?.phase === "started" || goal!.dispatch?.phase === "finished") &&
            goal!.dispatch?.messageID &&
            inbox &&
            (yield* inbox.acknowledged(identity.agentID, source.source, sessionID, goal!.dispatch.messageID))
          )
            return
          return yield* new RayaTask.GuardError({
            message: "This reviewed reply no longer has its original undelivered source.",
          })
        }
        if (row && errands) {
          const marker = goal!.replyRecovery!
          yield* errands.rearm(row.id, prior, {
            intent: marker.intent,
            source: marker.source,
            execution: marker.execution,
          })
        }
      }
      if (reviewed && prior && organizations && (yield* organizations.stopped(prior.agentID)))
        return yield* new RayaTask.GuardError({ message: "This worker's organization is stopping or archived." })
      if (reviewed && prior && prior.trigger?.kind === "timer" && schedule) {
        const marker = goal!.replyRecovery!
        yield* schedule.rearm(prior, { intent: marker.intent, source: marker.source, execution: marker.execution })
      }
      if (reviewed && prior && prior.status === "blocked") {
        if (
          !(yield* tasks.transition(prior, {
            ...prior,
            status: "running",
            blockedReason: undefined,
            outcome: undefined,
          }))
        )
          return yield* new RayaTask.GuardError({ message: "This worker reply changed before recovery resumed." })
      }
      const run =
        reviewed && prior
          ? { ...prior, status: "running" as const, blockedReason: undefined, outcome: undefined }
          : active.flat().find((run) => run.sessionID === sessionID && RayaTask.pending(run))
      if (!run) {
        yield* revive().pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("task resume recovery failed", { sessionID, err: Cause.squash(cause) })),
          ),
        )
        return
      }
      if (reviewed && prior) {
        const session = yield* input.sessions.get(sessionID)
        const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
          Effect.mapError(
            () => new RayaTask.GuardError({ message: "This reviewed worker's identity changed before continuation." }),
          ),
        )
        const row = yield* assignment(prior, identity)
        if (
          row &&
          (!errands ||
            row.state !== "running" ||
            (row.deadline !== undefined && row.deadline <= Date.now()) ||
            !(yield* errands.authorize(row)))
        )
          return yield* new RayaTask.GuardError({ message: "This assignment changed before continuation could start." })
      }
      yield* launch(run).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => log.error("routine resume admission failed", { sessionID, err: Cause.squash(cause) })),
        ),
      )
    })

    const reviewReply = Effect.fn("RayaTaskRunner.reviewReply")(function* (sessionID: SessionID, intent: string) {
      yield* transfer.check()
      const goal = yield* goals.get(sessionID)
      const marker = goal?.replyRecovery
      if (!goal || !marker || marker.reviewedAt !== undefined || goal.intent !== intent)
        return yield* new RayaTask.GuardError({ message: "This worker reply changed before review.", kind: "conflict" })
      const session = yield* input.sessions.get(sessionID)
      const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
        Effect.mapError(
          () => new RayaTask.GuardError({ message: "This worker reply has invalid recovery ownership." }),
        ),
      )
      if (identity.trigger.kind === "timer" && (identity.version !== 2 || !schedule))
        return yield* new RayaTask.GuardError({
          message: "This scheduled reply needs its original occurrence before it can continue.",
        })
      const prior = (yield* tasks.runsFor(identity.agentID)).find(
        (run) => run.id === identity.runID && run.sessionID === sessionID,
      )
      if (organizations && (yield* organizations.stopped(identity.agentID)))
        return yield* new RayaTask.GuardError({ message: "This worker's organization is stopping or archived." })
      const pending = inbox ? yield* inbox.stranded(identity.agentID) : undefined
      if (
        !prior ||
        (prior.status !== "running" && prior.status !== "blocked") ||
        identity.scheduleVersion !== (prior.scheduleVersion ?? 1) ||
        !isDeepStrictEqual(identity.trigger, prior.trigger) ||
        pending?.source !== marker.source ||
        pending.sessionID !== sessionID
      )
        return yield* new RayaTask.GuardError({
          message: "This worker reply no longer has its original pending follow-up.",
        })
      const receipt = (yield* execution.receipt(prior)) ?? (yield* execution.reviewed(prior, marker.execution))
      if (!receipt || createHash("sha256").update(receipt.token).digest("hex") !== marker.execution)
        return yield* new RayaTask.GuardError({
          message: "This worker reply's execution ownership changed before review.",
        })
      const row = yield* assignment(prior, identity)
      const context = { intent: marker.intent, source: marker.source, execution: marker.execution }
      if (row && errands) yield* errands.review(row.id, prior, context)
      if (identity.trigger.kind === "timer" && schedule)
        yield* schedule.review(prior, { intent: marker.intent, source: marker.source, execution: marker.execution })
      yield* execution.review(prior, receipt.token)
      if (row && errands) yield* errands.rearm(row.id, prior, context)
      if (identity.trigger.kind === "timer" && schedule)
        yield* schedule.rearm(prior, { intent: marker.intent, source: marker.source, execution: marker.execution })
    })

    const start = Effect.fn("RayaTaskRunner.startErrand")(function* (taken: Errand) {
      yield* transfer.check()
      if (retained.has(taken.id))
        return yield* new RayaTask.GuardError({
          kind: "conflict",
          message: "This retained delegation needs review or an explicit stop before new work can start.",
        })
      if (!errands)
        return yield* new RayaTask.GuardError({
          kind: "unavailable",
          message: "The delegation store is unavailable.",
        })
      const sender = yield* tasks.get(taken.senderID)
      const recipient = yield* tasks.get(taken.recipientID)
      if (!taken.childRunID)
        return yield* new RayaTask.GuardError({
          message: "This accepted delegation predates durable startup ownership and needs recovery review.",
        })
      const prior = (yield* tasks.runsFor(recipient.id)).find((run) => run.id === taken.childRunID)
      if (prior) {
        const session = yield* input.sessions.get(prior.sessionID).pipe(Effect.orElseSucceed(() => undefined))
        const identity = session
          ? yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
              Effect.orElseSucceed(() => undefined),
            )
          : undefined
        if (
          !session ||
          !identity ||
          identity.agentID !== recipient.id ||
          identity.runID !== taken.childRunID ||
          identity.delegationID !== taken.id ||
          identity.scheduleVersion !== (prior.scheduleVersion ?? 1) ||
          !isDeepStrictEqual(identity.trigger, prior.trigger) ||
          identity.organizationID !== taken.organizationID ||
          identity.organizationRevision !== taken.organizationRevision
        )
          return yield* new RayaTask.GuardError({
            message: "This delegation's saved run identity is inconsistent and needs recovery review.",
          })
        if (taken.deadline !== undefined && taken.deadline <= Date.now()) {
          yield* errands.finish(taken.id, "failed", recipient, undefined, undefined, LATE)
          yield* drop(recipient.id, prior.sessionID, prior.id, LATE)
          return yield* errands.get(taken.id)
        }
        if (!(yield* errands.authorize(taken)))
          return yield* new RayaTask.GuardError({ message: "This assignment is no longer authorized to start." })
        yield* authority({ ...taken, sessionID: prior.sessionID }, prior)
        const goal = yield* goals.get(prior.sessionID)
        // Only recover an initial intake that never acquired execution ownership.
        if (
          prior.status !== "running" ||
          goal?.status !== "active" ||
          goal.replyRecovery ||
          (goal.dispatch && goal.dispatch.phase !== "queued") ||
          (yield* execution.receipt(prior))
        )
          return yield* new RayaTask.GuardError({ message: "This interrupted start needs recovery review." })
        const attached = yield* errands.attach(taken.id, prior.id, prior.sessionID)
        yield* launch(prior)
        return attached
      }
      if (!(yield* errands.authorize(taken))) {
        yield* errands.finish(
          taken.id,
          "failed",
          recipient,
          undefined,
          undefined,
          "The organization no longer authorizes this delegation.",
        )
        return yield* errands.get(taken.id)
      }
      if (taken.deadline !== undefined && taken.deadline <= Date.now()) {
        yield* errands.finish(taken.id, "failed", recipient, undefined, undefined, LATE)
        return yield* errands.get(taken.id)
      }
      const note = prompt(sender, recipient, {
        source: taken.source,
        senderID: taken.senderID,
        recipientID: taken.recipientID,
        organizationID: taken.organizationID,
        organizationRevision: taken.organizationRevision,
        objective: taken.objective,
        expected: taken.expected,
        context: taken.context,
        deadline: taken.deadline,
        budget: taken.budget,
        artifacts: taken.artifacts,
      })
      const run = yield* fire(recipient.id, undefined, note, {
        follow: false,
        defer: true,
        view: ceiling(sender, recipient),
        runID: taken.childRunID,
        delegationID: taken.id,
        budget: taken.budget === undefined ? undefined : { modelCost: taken.budget },
        guard: Effect.gen(function* () {
          const organization = taken.organizationID
            ? organizations
              ? yield* organizations
                  .authorize({
                    id: taken.organizationID,
                    revision: taken.organizationRevision,
                    senderID: taken.senderID,
                    recipientID: taken.recipientID,
                  })
                  .pipe(
                    Effect.mapError(
                      () =>
                        new RayaTask.GuardError({
                          message: "The organization no longer authorizes this delegation.",
                        }),
                    ),
                  )
              : yield* new RayaTask.GuardError({
                  message: "The organization no longer authorizes this delegation.",
                })
            : undefined
          if (!taken.organizationID && !(yield* errands.authorize(taken)))
            return yield* new RayaTask.GuardError({ message: "This delegation is no longer authorized." })
          if (taken.deadline !== undefined && taken.deadline <= Date.now())
            return yield* new RayaTask.GuardError({ message: LATE })
          return organization
        }),
      }).pipe(
        Effect.catch((err) =>
          Effect.gen(function* () {
            const claim = yield* inspect(input.storage, recipient.id)
            if (claim) return yield* Effect.fail(err)
            yield* errands.finish(
              taken.id,
              "failed",
              recipient,
              undefined,
              undefined,
              err instanceof Error ? err.message : "Delegated work could not start.",
            )
            return yield* Effect.fail(err)
          }),
        ),
      )
      const current = yield* errands.get(taken.id)
      if (current.deadline !== undefined && current.deadline <= Date.now()) {
        yield* errands.finish(current.id, "failed", recipient, undefined, undefined, LATE)
        yield* drop(recipient.id, run.sessionID, run.id, LATE)
        return yield* errands.get(current.id)
      }
      if (!(yield* errands.authorize(current)))
        return yield* new RayaTask.GuardError({ message: "This assignment is no longer authorized to start." })
      yield* authority({ ...current, sessionID: run.sessionID }, run)
      const attached = yield* errands.attach(taken.id, run.id, run.sessionID)
      yield* launch(run)
      return attached
    })

    const busy = Effect.fn("RayaTaskRunner.busy")(function* (id: string) {
      const last = (yield* tasks.runsFor(id)).at(-1)
      if (last && RayaTask.pending(last)) return true
      if (schedule && (yield* schedule.active(id)).length) return true
      return false
    })

    const removing = Effect.fn("RayaTaskRunner.removing")(function* (id: string) {
      const claim = yield* inspect(input.storage, id)
      if (!claim) return false
      if (!("runID" in claim)) return true
      return claim.operation === "remove"
    })

    const fetch = (id: string) =>
      Effect.gen(function* () {
        const live = yield* tasks
          .get(id)
          .pipe(Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(undefined)))
        if (live) return { agent: live, gone: false as const }
        const archived = yield* tasks
          .page({ agentID: id })
          .pipe(Effect.catchTag("RayaTask.GuardError", () => Effect.succeed({ items: [] as const })))
        const found = archived.items.find((item) => item.definition.id === id)
        if (found) return { agent: found.definition, gone: true as const }
        return
      })

    const delegate = Effect.fn("RayaTaskRunner.delegate")(function* (input: Ask) {
      yield* transfer.check()
      if (!errands)
        return yield* new RayaTask.GuardError({
          kind: "unavailable",
          message: "The delegation store is unavailable.",
        })
      const sender = yield* tasks.get(input.senderID)
      const found = yield* fetch(input.recipientID)
      if (!found) return yield* new RayaTask.NotFoundError({ message: "Agent not found" })
      const recipient = found.agent
      if (yield* removing(recipient.id))
        return yield* new RayaTask.GuardError({ message: "This worker is being removed and cannot accept new work." })
      const parent = input.parentRunID
        ? (yield* tasks.runsFor(sender.id)).find((run) => run.id === input.parentRunID)
        : undefined
      if (input.parentRunID) {
        if (!parent) return yield* new Invalid({ message: "The parent run was not found for this worker." })
        if (!RayaTask.pending(parent))
          return yield* new RayaTask.GuardError({ message: "The parent run has ended and cannot assign new work." })
      }
      const goal = parent ? yield* goals.get(parent.sessionID) : undefined
      const allocation = goal?.budget?.modelCost
        ? { limit: goal.budget.modelCost, spent: goal.usage.cost ?? 0 }
        : undefined
      yield* lapse(Date.now())
      const admitted = yield* errands.admit(input, sender, recipient, found.gone, allocation)
      if (parent && goal?.budget?.modelCost !== undefined)
        yield* sync(admitted.record).pipe(
          Effect.mapError(
            (err) => new RayaTask.GuardError({ message: err instanceof Error ? err.message : String(err) }),
          ),
        )
      const available = yield* tasks
        .get(recipient.id)
        .pipe(Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(undefined)))
      if ((!available || (yield* removing(recipient.id))) && admitted.record.state !== "failed") {
        const failed = yield* errands.finish(
          admitted.record.id,
          "failed",
          recipient,
          undefined,
          undefined,
          "This worker was removed before the request could start.",
        )
        yield* sync(failed)
        return failed
      }
      if ((yield* busy(recipient.id)) || admitted.record.state !== "queued") return admitted.record
      const taken = yield* errands.take(recipient.id, retained)
      if (!taken) return admitted.record
      const started = yield* start(taken)
      if (taken.id === admitted.record.id) return started
      return yield* errands.get(admitted.record.id)
    })

    const abort = Effect.fn("RayaTaskRunner.stopErrand")(function* (id: string, strict = false) {
      if (!errands)
        return yield* new RayaTask.GuardError({
          kind: "unavailable",
          message: "The delegation store is unavailable.",
        })
      const row = yield* errands.get(id)
      const kids = yield* errands.descendants(id)
      if (strict) {
        if (!input.halt)
          return yield* new RayaTask.GuardError({ message: "Routine stopping services are unavailable." })
        for (const item of [row, ...kids]) {
          if (!item.sessionID || item.state === "completed" || item.state === "failed" || item.state === "cancelled")
            continue
          const worker = (yield* fetch(item.recipientID))?.agent ?? absent(item.recipientID)
          yield* open(worker.dir, input.halt(item.sessionID))
        }
      }
      const recipient = (yield* fetch(row.recipientID))?.agent ?? absent(row.recipientID)
      const record = yield* errands.stop(row.id, recipient, "Stopped by the user.", yield* spent(row))
      yield* sync(record)
      for (const child of kids) {
        const other = (yield* fetch(child.recipientID))?.agent ?? absent(child.recipientID)
        const stopped = yield* errands.stop(
          child.id,
          other,
          "Stopped because the parent request was stopped.",
          yield* spent(child),
        )
        yield* sync(stopped)
      }
      const listed = [row, ...kids]
      for (const item of listed) {
        if (item.state === "completed" || item.state === "failed") continue
        const dropped = yield* drop(item.recipientID, item.sessionID, item.childRunID, "Stopped by the user.")
        if (strict || !item.sessionID) {
          if (dropped) yield* execution.finish(dropped)
          continue
        }
        if (!input.halt) continue
        const worker = (yield* fetch(item.recipientID))?.agent ?? absent(item.recipientID)
        const halted = yield* Effect.exit(open(worker.dir, input.halt(item.sessionID)))
        if (Exit.isFailure(halted)) {
          log.error("delegated session stop failed", { err: Cause.squash(halted.cause) })
          continue
        }
        if (dropped) yield* execution.finish(dropped)
      }
      if (strict) return record
      const seen = new Set<string>()
      for (const item of listed) {
        if (seen.has(item.recipientID)) continue
        seen.add(item.recipientID)
        if (yield* busy(item.recipientID)) continue
        const taken = yield* errands.take(item.recipientID, retained)
        if (!taken) continue
        yield* start(taken).pipe(
          Effect.catch((err) => Effect.sync(() => log.error("delegated follow-on failed", { err }))),
        )
      }
      return record
    })

    const stopMembers = Effect.fn("RayaTaskRunner.stopMembers")(function* (
      organization: string,
      members: readonly string[],
    ) {
      if (!input.halt || !input.database || !input.pty || !errands || !schedule)
        return yield* new RayaTask.GuardError({ message: "Routine stopping services are unavailable." })
      const database = input.database
      const pty = input.pty
      const queue = RayaTaskQueue.make(input.database)
      const seen = new Set<string>()
      for (const id of members) {
        const worker = yield* tasks.get(id)
        if (worker.enabled) yield* tasks.update(id, { enabled: false })
      }
      const history = yield* Effect.forEach(members, (id) => tasks.runsFor(id), { concurrency: 1 })
      const sessions = yield* lineage(
        input.database,
        members,
        history.flat().map((run) => run.sessionID),
      )
      yield* Effect.promise(() => BackgroundProcess.archive(organization, sessions, members))
      const fenced = yield* lineage(input.database, members, sessions)
      const failures: Cause.Cause<unknown>[] = []
      const collect = Effect.fn(function* (effect: Effect.Effect<void, unknown>) {
        const result = yield* Effect.exit(effect)
        if (Exit.isFailure(result)) failures.push(result.cause)
      })
      for (const id of members) {
        for (const row of yield* errands.held(id)) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          yield* collect(abort(row.id, true).pipe(Effect.asVoid))
        }
      }
      for (const id of members) {
        const worker = yield* tasks.get(id)
        for (const run of yield* tasks.runsFor(id)) {
          if (!RayaTask.pending(run)) continue
          const halted = yield* Effect.exit(open(worker.dir, input.halt(run.sessionID)))
          if (Exit.isFailure(halted)) {
            failures.push(halted.cause)
            continue
          }
          const next = {
            ...run,
            status: "error" as const,
            blockedReason: "Stopped because the organization was archived.",
          }
          yield* collect(
            Effect.gen(function* () {
              const changed = yield* tasks.transition(run, next)
              if (changed) yield* execution.finish(next)
              yield* schedule.settle(next)
              if (reservations) {
                const rows = yield* input.sessions.messages({ sessionID: run.sessionID })
                const cost = rows.reduce((sum, row) => sum + (row.info.role === "assistant" ? row.info.cost : 0), 0)
                yield* reservations.settle(run.id, run.sessionID, cost).pipe(Effect.orDie)
              }
            }),
          )
        }
        yield* collect(
          queue.discard(id, "Stopped because the organization was archived.").pipe(Effect.orDie, Effect.asVoid),
        )
        if ((yield* schedule.active(id)).length || (yield* inspect(input.storage, id)))
          yield* collect(
            Effect.fail(
              new RayaTask.GuardError({
                message: "A worker start is still in progress. Retry organization archive.",
              }),
            ),
          )
      }
      const terminal = yield* Effect.promise(() => import("@/kilocode/interactive-terminal"))
      for (const id of fenced) {
        yield* collect(
          Effect.gen(function* () {
            const session = yield* database.db
              .select({ directory: SessionTable.directory, workspace: SessionTable.workspace_id })
              .from(SessionTable)
              .where(eq(SessionTable.id, id))
              .get()
            if (!session?.directory.trim())
              return yield* new RayaTask.GuardError({
                message: "A worker terminal has no persisted workspace context.",
              })
            yield* collect(
              open(
                session.directory,
                Effect.tryPromise(() => terminal.InteractiveTerminal.stopSession(id)),
              ),
            )
            yield* collect(pty.stop(id, session.directory, session.workspace ?? undefined))
          }),
        )
      }
      for (const id of members)
        if ((yield* errands.held(id)).length)
          yield* collect(
            Effect.fail(
              new RayaTask.GuardError({
                message: "A worker still has outstanding delegated work. Retry organization archive.",
              }),
            ),
          )
      if (failures.length) return yield* Effect.failCause(failures[0])
    })

    const recoverStops = Effect.fn("RayaTaskRunner.recoverStops")(function* () {
      if (yield* transfer.held().pipe(Effect.orDie)) return
      if (!input.database || !input.halt) return
      const pending = RayaTaskOrganization.make(input.database, { ...tasks, stop: stopMembers }, input.storage)
      const results = yield* Effect.forEach(
        yield* pending.pending(),
        (row) => pending.archive(row.id, { expectedRevision: row.revision }).pipe(Effect.exit),
        { concurrency: 1 },
      )
      const failed = results.find(Exit.isFailure)
      if (failed) return yield* Effect.failCause(failed.cause)
    })

    const close = Effect.fn("RayaTaskRunner.closeErrand")(function* (run: RayaTask.Run, terminal = false) {
      if (!errands) return
      const row = yield* errands.bySession(run.sessionID)
      const recipient = yield* tasks.get(row?.recipientID ?? run.agentID)
      if (row) {
        const state =
          run.status === "complete"
            ? ("completed" as const)
            : run.status === "blocked" && run.blockedReason === WAIT
              ? ("needs_input" as const)
              : run.status === "blocked" || run.status === "error"
                ? ("failed" as const)
                : undefined
        if (!state) return
        const settled = yield* errands
          .finish(row.id, state, recipient, run.outcome?.summary, run.outcome?.cost, run.blockedReason)
          .pipe(
            Effect.catch((error) =>
              typeof error === "object" &&
              error !== null &&
              "_tag" in error &&
              error._tag === "RayaTaskDelegation.Conflict"
                ? Effect.void
                : Effect.die(error),
            ),
          )
        if (settled && !terminal)
          yield* sync(settled).pipe(
            Effect.catch((err) => Effect.sync(() => log.error("delegation budget settlement failed", { err }))),
          )
      }
      if (terminal) return
      if (yield* busy(recipient.id)) return
      const taken = yield* errands.take(recipient.id, retained)
      if (!taken) return
      yield* start(taken).pipe(
        Effect.catch((err) => Effect.sync(() => log.error("delegated follow-on failed", { err }))),
      )
    })

    const settle = Effect.fn("RayaTaskRunner.settle")(function* (sessionID: SessionID, exact?: RayaTask.Run) {
      if (yield* transfer.held().pipe(Effect.orDie)) return
      const recovery = (yield* goals.get(sessionID))?.replyRecovery
      // Review needs the original execution receipt; blocked is not a verified terminal outcome here.
      if (recovery && recovery.reviewedAt === undefined) return
      const items = yield* tasks.list()
      for (const item of items) {
        if (exact && item.id !== exact.agentID) continue
        const history = yield* tasks.runsFor(item.id)
        const matches = (entry: RayaTask.Run) =>
          entry.sessionID === sessionID &&
          (!exact ||
            (entry.id === exact.id &&
              entry.at === exact.at &&
              (entry.scheduleVersion ?? 1) === (exact.scheduleVersion ?? 1)))
        const run = history.findLast((entry) => matches(entry) && entry.status === "running")
        if (!run) {
          const done = history.findLast((entry) => matches(entry) && entry.status !== "running")
          if (done) {
            const goal = yield* goals.get(sessionID)
            if (goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined) continue
            const saved = yield* snapshots.find(done.id).pipe(Effect.orDie)
            if (
              saved &&
              (saved.agentID !== done.agentID ||
                saved.at !== done.at ||
                (saved.definition.scheduleVersion ?? 1) !== (done.scheduleVersion ?? 1))
            )
              yield* Effect.die(new Error("Saved startup snapshot does not match run history."))
            const definition = saved?.definition ?? item
            if (definition.memoryScope === "role" && done.outcome?.summary)
              yield* tasks.learn(item.id, done.id, done.outcome.summary)
            if (schedule && (done.status === "complete" || done.status === "blocked")) yield* schedule.settle(done)
            if (reservations && done.outcome)
              yield* reservations.settle(done.id, done.sessionID, done.outcome.cost).pipe(Effect.orDie)
            yield* retain(done)
            yield* close(done, !!exact)
            yield* execution.finish(done)
          }
          continue
        }
        const goal = yield* goals.get(sessionID)
        if (goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined) continue
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
        const summary = goal?.blockedReason?.trim() || goal?.reply?.body.trim() || goal?.audit?.summary?.trim() || ""
        const changed = yield* tasks.transition(run, {
          ...run,
          status,
          blockedReason: goal
            ? goal.blockedReason
            : "No saved goal is available to verify this run's result. Review its conversation and saved instructions before starting more work.",
          outcome: {
            kind: kind(definition.role, definition.objective),
            reply: goal?.completion === "reply" && goal.status === "complete" ? true : undefined,
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
          yield* tasks.learn(item.id, run.id, summary)
        }
        if (changed && schedule && (status === "complete" || status === "blocked"))
          yield* schedule.settle({ ...run, status, blockedReason: goal?.blockedReason })
        if (reservations) yield* reservations.settle(run.id, run.sessionID, cost).pipe(Effect.orDie)
        const latest = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
        if (latest) {
          yield* retain(latest)
          yield* close(latest, !!exact)
          yield* execution.finish(latest)
          if (!exact) yield* dispatch(item.id)
        }
      }
    })

    const generation = (record: {
      token: string
      owner: { host: string; pid: number; birth: string }
      createdAt: number
    }) =>
      createHash("sha256")
        .update(
          JSON.stringify([record.token, record.owner.host, record.owner.pid, record.owner.birth, record.createdAt]),
        )
        .digest("hex")
    const pinGoal = Effect.fn("RayaTaskRunner.pinGoal")(function* (sessionID: SessionID) {
      const refuse = () =>
        new RayaTask.GuardError({
          kind: "conflict",
          message: "This routine changed while its goal was stopping. Review its current run before continuing.",
        })
      const rows = (yield* Effect.forEach(yield* tasks.list(), (item) => tasks.runsFor(item.id)))
        .flat()
        .filter((run) => run.sessionID === sessionID)
      const selected = yield* Effect.filter(rows, (run) =>
        RayaTask.pending(run) ? Effect.succeed(true) : execution.retained(run),
      )
      const session = yield* input.sessions.get(sessionID)
      const identity = session.metadata?.rayaRoutine
      if (selected.length > 1) return yield* refuse()
      for (const run of selected) {
        const record = yield* Schema.decodeUnknownEffect(ContinuationRecord)(identity).pipe(Effect.mapError(refuse))
        if (
          record.agentID !== run.agentID ||
          record.runID !== run.id ||
          record.scheduleVersion !== (run.scheduleVersion ?? 1) ||
          !isDeepStrictEqual(record.trigger, run.trigger)
        )
          return yield* refuse()
      }
      const pin = {
        version: 1 as const,
        sessionDigest: createHash("sha256")
          .update(JSON.stringify(identity ?? null))
          .digest("hex"),
        runs: yield* Effect.forEach(selected, (run) =>
          execution.receipt(run).pipe(
            Effect.map((record) => ({
              id: run.id,
              agentID: run.agentID,
              sessionID: run.sessionID,
              at: run.at,
              scheduleVersion: run.scheduleVersion ?? 1,
              ...(run.trigger ? { trigger: run.trigger } : {}),
              ...(record ? { executionDigest: generation(record) } : {}),
            })),
          ),
        ),
      }
      return yield* Schema.decodeUnknownEffect(TaskRetirement)(pin).pipe(Effect.mapError(refuse))
    })

    const finishGoal = Effect.fn("RayaTaskRunner.finishGoal")(function* (
      sessionID: SessionID,
      value: TaskRetirement,
      finished: boolean,
    ) {
      const refuse = () =>
        new RayaTask.GuardError({
          kind: "conflict",
          message: "This routine changed while its goal was stopping. Review its current run before continuing.",
        })
      const pin = yield* Schema.decodeUnknownEffect(TaskRetirement)(value).pipe(Effect.mapError(refuse))
      if (!finished) {
        if (yield* goals.get(sessionID)) return yield* refuse()
        const session = yield* input.sessions.get(sessionID)
        if (
          createHash("sha256")
            .update(JSON.stringify(session.metadata?.rayaRoutine ?? null))
            .digest("hex") !== pin.sessionDigest
        )
          return yield* refuse()
        for (const run of pin.runs) {
          const record = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
            Effect.mapError(refuse),
          )
          if (
            record.agentID !== run.agentID ||
            record.runID !== run.id ||
            record.scheduleVersion !== run.scheduleVersion ||
            !isDeepStrictEqual(record.trigger, run.trigger)
          )
            return yield* refuse()
        }
      }
      for (const run of pin.runs) {
        if (run.sessionID !== sessionID) return yield* refuse()
        const rows = yield* tasks.runsFor(run.agentID)
        const prior = rows.find((row) => row.id === run.id)
        if (
          !prior ||
          prior.agentID !== run.agentID ||
          prior.sessionID !== run.sessionID ||
          prior.at !== run.at ||
          (prior.scheduleVersion ?? 1) !== (run.scheduleVersion ?? 1) ||
          !isDeepStrictEqual(prior.trigger, run.trigger)
        )
          return yield* refuse()
        if (finished) {
          if (RayaTask.pending(prior) || (yield* execution.retained(prior))) return yield* refuse()
          continue
        }
        if (rows.at(-1)?.id !== run.id) return yield* refuse()
        const receipt = yield* execution.receipt(prior)
        if (receipt && generation(receipt) !== run.executionDigest) return yield* refuse()
        if (prior.status === "blocked" && prior.blockedReason === WAIT) {
          if (
            !(yield* tasks.transition(prior, {
              ...prior,
              status: "error",
              blockedReason: "Stopped after the user reviewed this goal. No unverified result was accepted.",
            }))
          )
            return yield* refuse()
        }
        yield* settle(sessionID, prior)
        const final = (yield* tasks.runsFor(run.agentID)).find((row) => row.id === run.id)
        if (!final || RayaTask.pending(final)) return yield* refuse()
        if (yield* execution.retained(run)) {
          const receipt = yield* execution.receipt(final)
          if (!receipt || receipt.state !== "idle" || generation(receipt) !== run.executionDigest)
            return yield* refuse()
          yield* execution.review(final, receipt.token)
        }
        if (yield* execution.retained(run)) return yield* refuse()
      }
      if (!finished) {
        const remaining = (yield* Effect.forEach(yield* tasks.list(), (item) => tasks.runsFor(item.id)))
          .flat()
          .some((run) => run.sessionID === sessionID && RayaTask.pending(run))
        if (remaining) return yield* refuse()
      }
      return undefined
    })

    // A dispatch accepted before cutoff owns only its exact terminal settlement.
    // Late event intake stays closed; settlement cannot launch dependent work.
    const retirement = (run: RayaTask.Run): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (!admission.snapshot().closed) return
        const session = yield* input.sessions.get(run.sessionID)
        const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine)
        if (
          identity.runID !== run.id ||
          identity.agentID !== run.agentID ||
          identity.scheduleVersion !== (run.scheduleVersion ?? 1)
        )
          return
        const goal = yield* goals.get(run.sessionID)
        // The prompt transport can return after its child was cancelled. Preserve
        // its actual durable interruption rather than retiring this owner as idle.
        if (goal?.dispatch?.intent === (goal?.intent ?? "unset") && goal.dispatch.outcome === "interrupted")
          return yield* Effect.interrupt
        if (goal?.dispatch?.messageID && goal.dispatch.intent === (goal.intent ?? "unset")) {
          const messages = yield* input.sessions.messages({ sessionID: run.sessionID })
          const reply = messages
            .filter((row) => row.info.role === "assistant" && row.info.parentID === goal.dispatch!.messageID)
            .toSorted((a, b) => a.info.id.localeCompare(b.info.id))
            .at(-1)
          if (
            goal.completion === "reply" &&
            reply?.info.role === "assistant" &&
            (!reply.info.finish || reply.info.finish === "tool-calls")
          )
            return yield* Effect.die(new Error("Accepted Routine reply has no verified terminal transport outcome."))
          if (reply?.info.role === "assistant" && !reply.info.error && reply.info.time.completed !== undefined) {
            const finished = yield* Effect.gen(function* () {
              const current = yield* goals.get(run.sessionID)
              if (!current?.dispatch || current.dispatch.id !== goal.dispatch?.id || current.intent !== goal.intent)
                return
              return yield* goals.finished(
                run.sessionID,
                reply.info.id,
                "completed",
                current.dispatch.phase === "finished",
              )
            }).pipe(
              Effect.retry({ times: 2, while: (err) => err instanceof RayaGoal.AuditError && err.conflict === true }),
            )
            if (finished)
              yield* goals.recordTurn(run.sessionID, reply.info.id, goal.intent).pipe(
                Effect.retry({
                  times: 2,
                  while: (err) => err instanceof RayaGoal.AuditError && err.conflict === true,
                }),
              )
          }
        }
        yield* settle(run.sessionID, run)
      })

    const terminal = Effect.fn("RayaTaskRunner.terminal")(function* (run: RayaTask.Run) {
      yield* transfer.check()
      const goal = yield* goals.get(run.sessionID)
      if (goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined) return { state: "blocked" as const, run }
      if (!(yield* execution.retained(run))) return { state: "skip" as const, run }
      if (!run.outcome || (run.status !== "complete" && run.status !== "blocked") || RayaTask.pending(run))
        return { state: "blocked" as const, run }
      if (!goal || goal.status !== run.status) return { state: "blocked" as const, run }
      const snapshot = yield* snapshots.find(run.id).pipe(Effect.orElseSucceed(() => undefined))
      if (
        !snapshot ||
        snapshot.runID !== run.id ||
        snapshot.agentID !== run.agentID ||
        snapshot.at !== run.at ||
        (snapshot.definition.scheduleVersion ?? 1) !== (run.scheduleVersion ?? 1)
      )
        return { state: "blocked" as const, run }
      const session = yield* input.sessions.get(run.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session?.metadata?.rayaRoutine).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (
        session?.id !== run.sessionID ||
        !identity ||
        identity.agentID !== run.agentID ||
        identity.runID !== run.id ||
        identity.scheduleVersion !== (run.scheduleVersion ?? 1) ||
        !isDeepStrictEqual(identity.trigger, run.trigger)
      )
        return { state: "blocked" as const, run }
      const permit = yield* execution.terminal(run)
      if (!permit) return { state: "blocked" as const, run }
      return { state: "ready" as const, run, permit }
    })

    const resolve = Effect.fn("RayaTaskRunner.resolve")(function* (id: string, runID: string) {
      yield* transfer.check()
      yield* tasks.get(id)
      const claim = yield* inspect(input.storage, id)
      const current = claim && "runID" in claim ? claim : undefined
      const reason =
        current?.runID === runID && current.recovery === "followup"
          ? "Closed after reviewing an uncertain follow-up delivery. The follow-up was not resent."
          : "Closed after reviewing an interrupted start. No unverified result was accepted."
      const source = `recovery:${runID}`
      const now = Date.now()
      const history = yield* tasks.runsFor(id)
      const prior = history.find((run) => run.id === runID)
      const page = inbox ? yield* inbox.page(id) : undefined
      const receipt = page?.messages.find((item) => item.source === source)
      if (receipt)
        return {
          agentID: id,
          runID,
          ...(receipt.sessionID ? { sessionID: receipt.sessionID } : {}),
          closedAt: receipt.time,
          reason: receipt.body,
        }
      const rows = schedule ? yield* schedule.active(id) : []
      const row = rows.find((item) => item.claim_id === runID)
      if (!row && current?.runID !== runID)
        return yield* new RayaTask.GuardError({
          kind: "conflict",
          message: "This interrupted start is no longer current. Reload its recovery review.",
        })
      const expired = !!row && (row.lease_until ?? 0) <= now
      const sid = prior?.sessionID ?? (row?.session_id ? SessionID.make(row.session_id) : undefined)
      const result = Effect.fn("RayaTaskRunner.resolve.result")(function* () {
        const current = inbox ? yield* inbox.page(id) : undefined
        const saved = current?.messages.find((item) => item.source === source)
        return {
          agentID: id,
          runID,
          ...(sid ? { sessionID: sid } : {}),
          closedAt: saved?.time ?? now,
          reason,
        }
      })
      const finish = Effect.fn("RayaTaskRunner.resolve.finish")(function* (trusted: boolean) {
        const sessionID = sid
        if (sessionID) {
          const goal = yield* goals.get(sessionID)
          if (goal?.status === "active" || goal?.status === "paused")
            yield* goals.update(sessionID, { status: "blocked", reason }, goal.revision).pipe(
              Effect.catchTag("RayaGoal.AuditError", (err) =>
                Effect.fail(new RayaTask.GuardError({ kind: "conflict", message: err.message })),
              ),
              Effect.catchTag("RayaGoal.NotFoundError", () => Effect.void),
            )
          yield* settle(sessionID)
          if (reservations && !prior) {
            const msgs = yield* input.sessions.messages({ sessionID })
            const cost = msgs.reduce((sum, item) => sum + (item.info.role === "assistant" ? item.info.cost : 0), 0)
            yield* reservations.settle(runID, sessionID, cost).pipe(Effect.orDie)
          }
          const current = (yield* tasks.runsFor(id)).find((run) => run.id === runID)
          if (current && RayaTask.pending(current)) {
            const next = { ...current, status: "error" as const, blockedReason: reason }
            if (yield* tasks.transition(current, next)) yield* execution.finish(next)
          }
        } else if (reservations) {
          yield* reservations.release(runID)
        }
        const active = schedule ? (yield* schedule.active(id)).find((item) => item.claim_id === runID) : undefined
        if (active && schedule)
          yield* schedule.resolve({
            id: active.id,
            claimID: runID,
            ...(active.session_id ? { sessionID: active.session_id } : {}),
            reason,
            now,
            requireExpired: !trusted,
          })
        if (inbox)
          yield* inbox.publish({
            agentID: id,
            source,
            kind: "system",
            body: reason,
            ...(sessionID ? { sessionID } : {}),
          })
        return true
      })
      if (current?.runID === runID) {
        const closed = yield* recover(
          input.storage,
          id,
          (claim) => Effect.succeed(claim.id === runID),
          (claim) => finish(stopped(claim.owner)),
          (claim) =>
            Effect.gen(function* () {
              if (stopped(claim.owner)) return true
              if (!schedule) return false
              const current = (yield* schedule.active(id)).find((item) => item.claim_id === runID)
              return !!current && (current.lease_until ?? 0) <= now
            }),
        )
        if (closed) return yield* result()
      }
      if (row && expired) {
        yield* finish(false)
        return yield* result()
      }
      return yield* new RayaTask.GuardError({
        kind: "conflict",
        message: "This start may still have a live owner. Wait for its recovery lease before closing it.",
      })
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
        if (!run) continue
        const goal = yield* goals.get(run.sessionID)
        if (goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined) continue
        if (RayaTask.pending(run)) {
          if (run.status !== "running" || (goal?.status !== "blocked" && goal?.status !== "complete")) continue
          const valid = Effect.gen(function* () {
            const current = (yield* schedule.active(id)).find((entry) => entry.id === row.id)
            if (
              current?.agent_id !== run.agentID ||
              current.schedule_version !== (run.scheduleVersion ?? 1) ||
              current.claim_id !== run.id ||
              current.session_id !== run.sessionID
            )
              return false
            const session = yield* input.sessions.get(run.sessionID)
            const identity = yield* Schema.decodeUnknownEffect(ContinuationRecord)(session.metadata?.rayaRoutine).pipe(
              Effect.orElseSucceed(() => undefined),
            )
            return (
              session.id === run.sessionID &&
              !!identity &&
              identity.version === 2 &&
              identity.agentID === run.agentID &&
              identity.runID === run.id &&
              identity.scheduleVersion === (run.scheduleVersion ?? 1) &&
              isDeepStrictEqual(identity.trigger, run.trigger) &&
              (yield* schedule.owned(run)) &&
              (yield* execution.authorized(run)) === true
            )
          })
          if (!(yield* valid)) continue
          const receipt = yield* execution.receipt(run)
          if (receipt?.state !== "idle") continue
          // Goal bookkeeping may finish after the earlier TurnClose settlement hint.
          // Repair only this exact owned terminal run; never launch a follow-on turn.
          yield* execution.enter(
            run,
            Effect.gen(function* () {
              if (!(yield* valid)) return
              const goal = yield* goals.get(run.sessionID)
              if (
                (goal?.status !== "blocked" && goal?.status !== "complete") ||
                (goal.replyRecovery && goal.replyRecovery.reviewedAt === undefined)
              )
                return
              yield* settle(run.sessionID, run)
            }),
          )
          continue
        }
        if (
          (run.status === "complete" && goal?.status === "complete") ||
          (run.status === "blocked" && goal?.status === "blocked")
        )
          yield* schedule.settle(run)
      }
    })

    const revive: Runner["revive"] = Effect.fn("RayaTaskRunner.revive")(function* () {
      if (yield* transfer.held().pipe(Effect.orDie)) return
      const items = yield* tasks.list()
      for (const item of items) {
        if (organizations && (yield* organizations.stopped(item.id))) continue
        const prior = yield* tasks.runsFor(item.id)
        const resumed = new Set<string>()
        // Saved history retains at most 50 terminal runs plus its schedule anchor; replay each retained candidate.
        for (const run of prior) {
          const goal = yield* goals.get(run.sessionID)
          if (
            (run.status === "blocked" || run.status === "running") &&
            goal?.status === "active" &&
            goal.replyRecovery?.reviewedAt !== undefined &&
            goal.replyRecovery.reviewIntent === goal.intent &&
            (goal.dispatch?.id === goal.replyRecovery.dispatchID || goal.dispatch?.intent === goal.intent)
          ) {
            yield* resume(run.sessionID)
            resumed.add(run.id)
          }
        }
        const current = yield* tasks.runsFor(item.id)
        const done: RayaTask.Run[] = []
        for (const run of current) {
          if (!run.outcome || (run.status !== "complete" && run.status !== "blocked") || RayaTask.pending(run)) continue
          const goal = yield* goals.get(run.sessionID)
          if (goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined) continue
          done.push(run)
        }
        const restored = yield* Effect.gen(function* () {
          const admitted = yield* Effect.forEach(
            done,
            (run) =>
              Effect.acquireRelease(terminal(run), (entry) =>
                entry.state === "ready" ? execution.defer(entry.permit) : Effect.void,
              ),
            { concurrency: 1 },
          )
          if (admitted.some((entry) => entry.state === "blocked")) return false
          const ready = admitted.filter((entry) => entry.state === "ready")
          yield* Effect.forEach(ready, (entry) => execution.recover(entry.permit, settle(entry.run.sessionID)), {
            concurrency: 1,
            discard: true,
          })
          return true
        }).pipe(Effect.scoped)
        if (!restored) continue
        yield* reconcile(item.id)
        const recovering = yield* Effect.forEach(yield* tasks.runsFor(item.id), (run) => goals.get(run.sessionID))
        if (recovering.some((goal) => goal?.replyRecovery && goal.replyRecovery.reviewedAt === undefined)) continue
        const stranded = inbox ? yield* inbox.stranded(item.id) : undefined
        if (stranded?.sessionID && inbox) {
          const history = yield* tasks.runsFor(item.id)
          const prior = history.find((run) => run.sessionID === stranded.sessionID)
          if (prior && !RayaTask.pending(prior) && !history.some(RayaTask.pending))
            yield* ask(item.id, stranded.body, {
              defer: true,
              bind: { source: stranded.source, sessionID: stranded.sessionID },
            })
        }
        const waiting = inbox ? yield* inbox.pending(item.id) : undefined
        if (waiting && inbox) {
          const resumed = yield* ask(item.id, waiting.body, { defer: true })
          yield* inbox.attach(item.id, waiting.source, resumed.sessionID)
        }
        const history = yield* tasks.runsFor(item.id)
        const run = history.findLast((entry) => entry.status === "running")
        if (run && resumed.has(run.id)) continue
        const assigned = run && errands ? yield* errands.bySession(run.sessionID) : undefined
        if (assigned && retained.has(assigned.id)) continue
        const held = errands ? yield* errands.accepted(item.id) : undefined
        if (held && retained.has(held.id)) continue
        if (run && held?.childRunID === run.id) {
          yield* start(held).pipe(
            Effect.catch((err) => Effect.sync(() => log.error("delegated attachment recovery failed", { err }))),
          )
        }
        if (!run) {
          if (!errands || history.some(RayaTask.pending)) continue
          const taken = yield* errands.take(item.id, retained)
          if (!taken) continue
          yield* start(taken).pipe(
            Effect.catch((err) => Effect.sync(() => log.error("delegated restart failed", { err }))),
          )
          continue
        }
        yield* settle(run.sessionID)
        const again = (yield* tasks.runsFor(item.id)).find((entry) => entry.id === run.id)
        if (again?.status !== "running") continue
        if (schedule && !(yield* schedule.owned(again))) continue
        yield* launch(again)
      }
    })

    const announce = Effect.fn("RayaTaskRunner.announce")(function* (source: string, filter?: string) {
      if (yield* transfer.held().pipe(Effect.orDie)) return []
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

    const pulse = (from: number) =>
      lapse(from).pipe(
        Effect.andThen(schedule ? schedule.clean() : Effect.void),
        Effect.andThen(tasks.list()),
        Effect.flatMap((items) =>
          Effect.forEach(
            items,
            (item) =>
              Effect.gen(function* () {
                if (organizations && (yield* organizations.stopped(item.id))) return undefined
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

    const tick = (from: number) =>
      Effect.gen(function* () {
        if (yield* transfer.held().pipe(Effect.orDie)) return
        yield* pulse(from)
      })

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
            const held = errands
              ? (yield* errands.held(item.id)).find((row) => row.recipientID === item.id && retained.has(row.id))
              : undefined
            if (held)
              return {
                ...item,
                nextRun: undefined,
                note: [
                  "A retained delegation is held after restart. Review the assignment and explicitly stop it before replacing it with new work.",
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

    const runner: Runner = {
      tick: (from) => intake(tick(from)),
      preview: (from) => initialize.pipe(Effect.andThen(preview(from))),
      fire: (...args) => intake(fire(...args)) as ReturnType<Runner["fire"]>,
      ask: (...args) => intake(ask(...args)) as ReturnType<Runner["ask"]>,
      dispatch: (...args) => intake(dispatch(...args)) as ReturnType<Runner["dispatch"]>,
      resume: (...args) => intake(resume(...args)),
      reviewReply: (...args) => intake(reviewReply(...args)),
      delegate: (...args) => intake(delegate(...args)) as ReturnType<Runner["delegate"]>,
      stop: (...args) => intake(abort(...args)) as ReturnType<Runner["stop"]>,
      stopMembers: (...args) => intake(stopMembers(...args)),
      recoverStops: () => intake(recoverStops()),
      settle: (...args) => intake(settle(...args)) as ReturnType<Runner["settle"]>,
      stopGoal: (body) =>
        intake(
          body({
            prepare: (sessionID) =>
              pinGoal(sessionID).pipe(
                Effect.mapError(
                  () =>
                    new RayaTask.GuardError({
                      kind: "conflict",
                      message:
                        "This routine changed while its goal was stopping. Review its current run before continuing.",
                    }),
                ),
              ),
            finish: (sessionID, pin, finished) =>
              finishGoal(sessionID, pin, finished).pipe(
                Effect.mapError(
                  () =>
                    new RayaTask.GuardError({
                      kind: "conflict",
                      message:
                        "This routine changed while its goal was stopping. Review its current run before continuing.",
                    }),
                ),
              ),
          }),
        ).pipe(Effect.uninterruptible),
      resolve: (...args) => intake(resolve(...args)) as ReturnType<Runner["resolve"]>,
      park: (...args) => intake(park(...args)) as ReturnType<Runner["park"]>,
      revive: () => intake(revive()) as ReturnType<Runner["revive"]>,
      announce: (...args) => intake(announce(...args)).pipe(Effect.orDie),
      tasks,
    }
    return {
      runner,
      events: {
        settle: (...args: Parameters<Runner["settle"]>) =>
          initialize.pipe(Effect.andThen((settle as Runner["settle"])(...args))),
        park: park as Runner["park"],
      },
    }
  }

  export function make(input: Parameters<typeof build>[0]): Runner {
    return build(input).runner
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
    halt?: (sessionID: SessionID) => Effect.Effect<void>
    pty?: PtyArchive.Interface
    contact?: { clock?: () => number; interval?: Duration.Input; batch?: number }
  }) {
    const owned = build(input)
    const runner = owned.runner
    return Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const scope = yield* Effect.scope
      const reviews = new Map<string, Review>()
      const inbox = input.database ? RayaTaskInbox.make(input.database) : undefined
      const receipt = Effect.fn("RayaTaskRunner.permissionReceipt")(function* (review: Review, reply: string) {
        if (!inbox) return
        const items = yield* runner.tasks.list()
        for (const item of items) {
          const runs = yield* runner.tasks.runsFor(item.id)
          const run = runs.findLast((entry) => entry.sessionID === review.sessionID)
          if (!run) continue
          const decision =
            reply === "once"
              ? "Approved for this call"
              : reply === "always"
                ? "Approved with 'always allow' selected"
                : "Rejected"
          const patterns = review.patterns.slice(0, 8).map((pattern) => `- ${plain(pattern)}`)
          const body = [
            "Authority receipt",
            `Worker: ${plain(item.name, 256)}`,
            `Run: ${plain(run.id, 256)}`,
            `Permission: ${plain(review.permission, 256)}`,
            `Decision: ${decision}`,
            ...(patterns.length ? ["Requested scope:", ...patterns] : []),
            `Request: ${plain(review.requestID, 256)}`,
            ...(review.callID ? [`Tool call: ${plain(review.callID, 256)}`] : []),
            "This receipt records the decision. It does not change the worker's saved access.",
          ]
            .join("\n")
            .slice(0, 8000)
          yield* inbox.publish({
            agentID: item.id,
            source: `authority:${createHash("sha256").update(review.requestID).digest("hex").slice(0, 40)}`,
            kind: "system",
            body,
            sessionID: review.sessionID,
          })
          return
        }
      })
      yield* Effect.acquireRelease(
        input.bus.subscribeCallback(KiloSession.Event.TurnClose, (event) => {
          if (admission.snapshot().closed) return
          if (event.properties.reason === "superseded") return
          const sid = event.properties.sessionID
          admission.dispatch(
            Effect.gen(function* () {
              const goals = RayaGoal.make({ storage: input.storage, sessions: input.sessions })
              for (const delay of [0, 25, 50, 100, 200, 400]) {
                const goal = yield* goals.get(sid)
                if (!goal || goal.completion !== "reply" || goal.status !== "active") break
                yield* Effect.sleep(Duration.millis(delay))
              }
              yield* owned.events.settle(sid)
            }).pipe(
              (body) => admission.observe(body, known),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.sync(() => log.error("task settle failed", { sessionID: sid, err: Cause.squash(cause) })),
              ),
            ),
            scope,
            bridge.fork,
          )
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const asked = new Set(["permission.asked", "question.asked"])
          const replied = new Set(["permission.replied", "question.replied", "question.rejected"])
          const listener = (event: GlobalEvent) => {
            if (admission.snapshot().closed) return
            const type = event.payload?.type
            const data = event.payload?.properties ?? event.payload?.data
            const raw = data?.sessionID
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
            if (type === "permission.asked") {
              const requestID = typeof data?.id === "string" ? data.id : undefined
              const permission = typeof data?.permission === "string" ? data.permission : undefined
              const patterns = Array.isArray(data?.patterns)
                ? data.patterns.filter((value: unknown): value is string => typeof value === "string")
                : []
              if (requestID && permission)
                reviews.set(requestID, {
                  sessionID: sid,
                  requestID,
                  permission,
                  patterns,
                  ...(typeof data?.tool?.callID === "string" ? { callID: data.tool.callID } : {}),
                })
            }
            const review =
              type === "permission.replied" && typeof data?.requestID === "string"
                ? reviews.get(data.requestID)
                : undefined
            const saved =
              review && typeof data?.reply === "string"
                ? receipt(review, data.reply).pipe(
                    Effect.tap(() => Effect.sync(() => reviews.delete(review.requestID))),
                  )
                : Effect.void
            admission.dispatch(
              Effect.gen(function* () {
                if (input.database) {
                  const row = yield* RayaTaskDelegation.make(input.database).bySession(sid)
                  const session = yield* input.sessions.get(sid)
                  const raw = session.metadata?.rayaRoutine
                  // Delegated request hooks own waiting and approval synchronously.
                  // Delayed events must not re-park a reply or reopen a later question.
                  if (row || (typeof raw === "object" && raw !== null && Object.hasOwn(raw, "delegationID"))) return
                }
                yield* owned.events.park(sid, waiting)
              }).pipe(
                Effect.andThen(saved),
                (body) => admission.observe(body, known),
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.sync(() => log.error("task park failed", { sessionID: sid, err: Cause.squash(cause) })),
                ),
              ),
              scope,
              bridge.fork,
            )
          }
          GlobalBus.on("event", listener)
          return listener
        }),
        (listener) => Effect.sync(() => GlobalBus.off("event", listener)),
      )
      yield* Effect.logInfo("Raya routine stop recovery starting")
      yield* runner
        .recoverStops()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("organization stop recovery failed", { err: Cause.squash(cause) })),
          ),
        )
      yield* Effect.logInfo("Raya routine stop recovery complete")
      yield* Effect.logInfo("Raya routine revival starting")
      yield* runner
        .revive()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("task revive failed", { err: Cause.squash(cause) })),
          ),
        )
      yield* Effect.logInfo("Raya routine revival complete")
      if (input.database) {
        const organizations = RayaTaskOrganization.make(input.database, runner.tasks, input.storage)
        const messenger = RayaContactMessenger.make(input.database, {
          clock: input.contact?.clock,
          exists: (id) =>
            hold(input.storage)
              .held()
              .pipe(
                Effect.orDie,
                Effect.flatMap((held) =>
                  held
                    ? Effect.succeed(false)
                    : runner.tasks.get(id).pipe(
                        Effect.map((item) => item.enabled),
                        Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(false)),
                      ),
                ),
              ),
          permit: (request, target) =>
            target.scope.kind !== "organization"
              ? Effect.succeed(true)
              : request.agentID
                ? organizations.contains(target.scope.id, [request.agentID])
                : Effect.succeed(false),
        })
        yield* poll(
          Effect.gen(function* () {
            if (yield* hold(input.storage).held().pipe(Effect.orDie)) return
            yield* messenger.drain(input.contact?.batch ?? 50)
          }).pipe(Effect.uninterruptible),
          (cause) => log.error("Raya Messenger poll failed", { err: Cause.squash(cause) }),
          input.contact?.interval,
        ).pipe(Effect.interruptible, Effect.forkScoped)
      }
      const tick = Effect.gen(function* () {
        yield* runner.tick(Date.now())
      })
      yield* poll(tick.pipe(Effect.uninterruptible), (cause) =>
        log.error("routine poll failed", { err: Cause.squash(cause) }),
      ).pipe(Effect.interruptible, Effect.forkScoped)
    }).pipe((body) =>
      admission
        .track(body, () => new RayaTask.GuardError({ message: "Routine scheduler admission is closed." }))
        .pipe(Effect.uninterruptible),
    )
  }
}
