import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Criteria } from "@/kilocode/goal/criteria"
import { Permission } from "@/permission"
import { next as cronNext, parse as cronParse, upcoming } from "./cron"
import { mutate } from "./mutation"
import { local } from "./local"
import { claim } from "./claim"
import { removals } from "./removal"
import { archive as indexed, InvalidCursor } from "./archive"
import { RayaTaskQueue } from "./queue"
import type { Database } from "@opencode-ai/core/database/database"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "raya-task-schedule" })

export namespace RayaTask {
  export const Role = Schema.Literals(["generalist", "coder", "designer", "accountant", "reviewer", "inbox", "briefer"])
  export type Role = typeof Role.Type

  export const Schedule = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("once"), at: Schema.Number }),
    Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String, tz: Schema.optional(Schema.String) }),
    Schema.Struct({
      kind: Schema.Literal("event"),
      source: Schema.String,
      filter: Schema.optional(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal("manual") }),
  ])
  export type Schedule = typeof Schedule.Type

  export const Proposal = Schema.Union([
    Schedule,
    Schema.Struct({
      kind: Schema.Literal("local"),
      local: Schema.String,
      tz: Schema.String,
      fold: Schema.optional(Schema.Literals(["reject", "earlier", "later"])),
    }),
  ])
  export type Proposal = typeof Proposal.Type

  export const Forecast = Schema.Struct({
    schedule: Schedule,
    from: Schema.Number,
    occurrences: Schema.Array(Schema.Number),
    timezone: Schema.optional(Schema.String),
  })

  export const forecast = Effect.fn("RayaTask.forecast")(function* (input: Proposal, from = Date.now()) {
    if (!Number.isFinite(from) || Math.abs(from) > 8.64e15)
      return yield* new GuardError({
        kind: "schedule",
        field: "schedule",
        message: "Use a valid schedule preview time.",
      })
    const resolved =
      input.kind === "local"
        ? yield* local(input.local, input.tz, input.fold).pipe(
            Effect.mapError(
              (err) =>
                new GuardError({
                  kind: "schedule",
                  field: "schedule",
                  message: err instanceof Error ? err.message : "Could not resolve this local time.",
                }),
            ),
          )
        : undefined
    const schedule = yield* scheduled(input.kind === "local" ? { kind: "once", at: resolved!.at } : input)
    if (schedule.kind === "once") {
      if (!Number.isFinite(schedule.at) || schedule.at <= from || schedule.at > 8.64e15)
        return yield* new GuardError({
          kind: "schedule",
          field: "schedule",
          message: "Choose a future time for this routine.",
        })
      return { schedule, from, occurrences: [schedule.at], ...(resolved ? { timezone: resolved.timezone } : {}) }
    }
    if (schedule.kind !== "cron") return { schedule, from, occurrences: [] }
    const occurrences: number[] = []
    while (occurrences.length < 3) {
      const at = yield* upcoming(schedule.expr, occurrences.at(-1) ?? from, schedule.tz).pipe(
        Effect.mapError(
          (err) =>
            new GuardError({
              kind: "schedule",
              field: "schedule",
              message: err instanceof Error ? err.message : "Could not preview this schedule.",
            }),
        ),
      )
      occurrences.push(at)
    }
    return { schedule, from, occurrences }
  })

  const Version = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  )

  const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
  export const Output = Schema.Struct({
    destination: Schema.Literal("conversation"),
    description: Text,
    criteria: Criteria,
  })
  export type Output = typeof Output.Type

  export const Agent = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    avatar: Schema.optional(Schema.String),
    role: Schema.String,
    objective: Schema.String,
    output: Schema.optional(Output),
    capabilities: Schema.Array(Schema.String),
    memoryScope: Schema.Literals(["role", "project", "session"]),
    schedule: Schedule,
    scheduleVersion: Schema.optional(Version),
    scheduleUpdatedAt: Schema.optional(Schema.Finite),
    enabled: Schema.Boolean,
    blockReset: Schema.optional(Schema.Array(Schema.String)),
    plan: Schema.optional(Schema.String),
    model: Schema.optional(Schema.Struct({ providerID: Schema.String, id: Schema.String })),
    mode: Schema.optional(Schema.String),
    dir: Schema.optional(Schema.String),
    access: Schema.optional(Schema.Literals(["full", "brief"])),
    tools: Schema.optional(Schema.Array(Schema.String)),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    note: Schema.optional(Schema.String),
    nextRun: Schema.optional(Schema.Number),
    execution: Schema.optional(
      Schema.Struct({
        state: Schema.Literals(["starting", "active", "recovery"]),
        runID: Schema.optional(Schema.String),
        sessionID: Schema.optional(SessionID),
      }),
    ),
  })
  export type Agent = typeof Agent.Type

  export const Archived = Schema.Struct({
    version: Schema.Literal(1),
    archivedAt: Schema.Finite,
    definition: Agent,
  })
  export const ArchivePage = Schema.Struct({ items: Schema.Array(Archived), next: Schema.optional(Schema.String) })

  export const Outcome = Schema.Struct({
    kind: Schema.Literals(["code", "notify"]),
    summary: Schema.String,
    evidence: Schema.optional(Schema.Array(Schema.String)),
    verification: Schema.optional(
      Schema.Struct({
        at: Schema.Number,
        requirements: Schema.Array(
          Schema.Struct({
            criterionID: Schema.optional(Schema.String),
            requirement: Schema.String,
            verification: Schema.optional(Schema.String),
            required: Schema.Boolean,
            passed: Schema.Boolean,
            evidence: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    cost: Schema.Number,
  })
  export type Outcome = typeof Outcome.Type

  const Timestamp = Schema.Number.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
  export const Trigger = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("manual") }),
    Schema.Struct({
      kind: Schema.Literal("timer"),
      id: Schema.String,
      scheduledAt: Timestamp,
      observedAt: Timestamp,
      tz: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal("event"),
      source: Schema.String,
      filter: Schema.optional(Schema.String),
      receivedAt: Timestamp,
    }),
  ])
  export type Trigger = typeof Trigger.Type

  export const Run = Schema.Struct({
    id: Schema.String,
    agentID: Schema.String,
    at: Schema.Number,
    sessionID: SessionID,
    status: Schema.Literals(["running", "complete", "blocked", "error"]),
    scheduleVersion: Schema.optional(Version),
    trigger: Schema.optional(Trigger),
    revision: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    ),
    outcome: Schema.optional(Outcome),
    blockedReason: Schema.optional(Schema.String),
  })
  export type Run = typeof Run.Type

  export const Create = Schema.Struct({
    name: Schema.String,
    role: Schema.optional(Schema.String),
    objective: Schema.String,
    output: Schema.optional(Output),
    capabilities: Schema.optional(Schema.Array(Schema.String)),
    memoryScope: Schema.optional(Schema.Literals(["role", "project", "session"])),
    schedule: Schedule,
    avatar: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
    plan: Schema.optional(Schema.String),
    model: Schema.optional(Schema.Struct({ providerID: Schema.String, id: Schema.String })),
    mode: Schema.optional(Schema.String),
    dir: Schema.optional(Schema.String),
    access: Schema.optional(Schema.Literals(["full", "brief"])),
    tools: Schema.optional(Schema.Array(Schema.String)),
  })
  export type Create = typeof Create.Type

  const CAP = 50
  const SAME = 3
  const sensitive = new Set(["accountant", "inbox"])
  const money = new Set(["money", "accounting", "books"])
  const messages = new Set(["messages", "email", "inbox"])

  export class GuardError extends Schema.TaggedErrorClass<GuardError>()("RayaTask.GuardError", {
    message: Schema.String,
    kind: Schema.optional(Schema.Literals(["schedule", "capability", "conflict", "paused", "access", "unavailable"])),
    field: Schema.optional(Schema.String),
  }) {}

  export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("RayaTask.NotFoundError", {
    message: Schema.String,
  }) {}

  type Store = Pick<Storage.Interface, "read" | "replace" | "create" | "remove">
  const roster = ["raya", "agent"]
  const history = (id: string) => ["raya", "agent-runs", id]
  const memory = (id: string) => ["raya", "agent-memory", id]
  const agents = Schema.decodeUnknownEffect(Schema.Array(Agent))
  const runs = Schema.decodeUnknownEffect(Schema.Array(Run))

  export function pending(run?: Run) {
    return run?.status === "running" || (run?.status === "blocked" && run.blockedReason === "waiting on you")
  }

  function timed(run: Run) {
    return !run.trigger || run.trigger.kind === "timer"
  }

  function cursor(run?: Run) {
    return run?.trigger?.kind === "timer" ? run.trigger.scheduledAt : run?.at
  }

  function consumed(items: readonly Run[], version: number) {
    return items.reduce<Run | undefined>((latest, run) => {
      if (!timed(run) || (run.scheduleVersion ?? 1) !== version) return latest
      return !latest || cursor(run)! >= cursor(latest)! ? run : latest
    }, undefined)
  }

  export function recorded(agent: Agent, items: readonly Run[], at: number) {
    const latest = consumed(items, agent.scheduleVersion ?? 1)
    return !!latest && (agent.schedule.kind === "once" || cursor(latest)! >= at)
  }

  export function next(agent: Agent, from: number, last?: Run) {
    if (!agent.enabled) return
    if (unzoned(agent.schedule)) return
    if (agent.schedule.kind === "manual") return
    if (agent.schedule.kind === "event") return
    if (pending(last)) return
    const current =
      last && timed(last) && (last.scheduleVersion ?? 1) === (agent.scheduleVersion ?? 1) ? last : undefined
    if (agent.schedule.kind === "once") {
      if (current) return
      return agent.schedule.at
    }
    const origin = cursor(current) ?? agent.scheduleUpdatedAt ?? agent.createdAt
    return cronNext(agent.schedule.expr, Math.max(origin, from - 60_000), agent.schedule.tz)
  }

  export function due(agent: Agent, from: number, last?: Run) {
    const at = next(agent, from, last)
    if (at === undefined) return
    if (agent.schedule.kind === "once") return at <= from ? at : undefined
    if (at <= from) return at
  }

  export function brief(agent: Pick<Agent, "role" | "access">) {
    if (agent.access === "full") return false
    if (agent.access === "brief") return true
    return agent.role.toLowerCase() === "briefer"
  }

  export function rules(agent: Pick<Agent, "role" | "access" | "tools">) {
    if (brief(agent)) {
      const cfg: Record<string, "allow" | "deny"> = { "*": "deny", question: "allow" }
      const reads = [
        "read",
        "glob",
        "grep",
        "list",
        "skill",
        "question",
        "todoread",
        "todowrite",
        "get_goal",
        "update_goal",
        "update_goal_plan",
      ]
      const selected = agent.tools?.length
        ? Permission.fromConfig(Object.fromEntries(agent.tools.map((tool) => [tool, "allow" as const])))
        : undefined
      for (const tool of reads) {
        if (!selected || Permission.evaluate(tool, "*", selected).action === "allow") cfg[tool] = "allow"
      }
      return Permission.fromConfig(cfg)
    }
    if (agent.tools?.length) {
      const cfg: Record<string, "allow" | "deny"> = { "*": "deny", question: "allow" }
      for (const tool of agent.tools) cfg[tool] = "allow"
      return Permission.fromConfig(cfg)
    }
    return Permission.fromConfig({ "*": "allow", edit: "allow", write: "allow", bash: "allow" })
  }

  export function listen(agent: Agent, source: string, filter?: string) {
    if (!agent.enabled) return false
    if (agent.schedule.kind !== "event") return false
    if (agent.schedule.source !== source) return false
    if (agent.schedule.filter !== undefined && agent.schedule.filter !== filter) return false
    return true
  }

  export function unzoned(schedule: Schedule) {
    return schedule.kind === "cron" && !schedule.tz?.trim()
  }

  function scheduled(input: Schedule) {
    if (input.kind !== "cron") return Effect.succeed(input)
    if (unzoned(input))
      return Effect.fail(
        new GuardError({
          kind: "schedule",
          field: "timezone",
          message: "Choose the intended timezone and preview this calendar schedule before saving it.",
        }),
      )
    return Effect.try({
      try: () => {
        cronParse(input.expr)
        return {
          ...input,
          tz: new Intl.DateTimeFormat("en-US", { timeZone: input.tz?.trim() }).resolvedOptions().timeZone,
        }
      },
      catch: (err) =>
        new GuardError({
          kind: "schedule",
          field: err instanceof RangeError ? "timezone" : "schedule",
          message:
            err instanceof RangeError
              ? "Use a valid timezone for this routine."
              : err instanceof Error
                ? err.message
                : "Use a valid calendar schedule.",
        }),
    })
  }

  export function make(deps: { storage: Store; database?: Database.Interface }) {
    const store = deps.database ? indexed(deps.database) : undefined
    const archives = () =>
      deps.storage.read(["raya", "agent-archive"]).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed([])),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Archived))),
        Effect.orDie,
      )
    const retain = (item: Agent) =>
      Effect.gen(function* () {
        const storage = yield* initialize()
        const definition = { ...item }
        delete definition.nextRun
        delete definition.execution
        const saved = yield* Schema.decodeUnknownEffect(Agent)(JSON.parse(JSON.stringify(definition))).pipe(
          Effect.orDie,
        )
        yield* storage
          .put({ id: item.id, archived_at: Date.now(), definition: JSON.stringify(saved) })
          .pipe(Effect.orDie)
      })
    const list = Effect.fn("RayaTask.list")(function* (required = false) {
      const raw = yield* deps.storage.read<unknown>([...roster]).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, (error) =>
          required ? Effect.fail(error) : Effect.succeed([]),
        ),
        Effect.orDie,
      )
      return yield* agents(raw).pipe(Effect.orDie)
    })

    const save = Effect.fn("RayaTask.save")(function* (items: Agent[]) {
      yield* deps.storage.replace([...roster], items).pipe(Effect.orDie)
    })

    const get = Effect.fn("RayaTask.get")(function* (id: string) {
      const items = yield* list()
      const found = items.find((item) => item.id === id)
      if (!found) return yield* new NotFoundError({ message: "Agent not found" })
      return found
    })

    const initialize = () =>
      Effect.gen(function* () {
        if (!store)
          return yield* new GuardError({
            kind: "unavailable",
            message: "The routine archive database is unavailable. Reconnect before reading or removing routines.",
          })
        if (yield* store.ready().pipe(Effect.orDie)) return store
        const saved = yield* archives()
        if (saved.length) yield* list(true)
        yield* store
          .migrate(
            saved.map((item) => ({
              id: item.definition.id,
              archived_at: item.archivedAt,
              definition: JSON.stringify(item.definition),
            })),
          )
          .pipe(Effect.orDie)
        return store
      })

    const page = (input: { cursor?: string; agentID?: string } = {}) =>
      mutate(
        deps.storage,
        Effect.gen(function* () {
          const storage = yield* initialize()
          const roster = yield* list(yield* storage.occupied().pipe(Effect.orDie))
          const result = yield* storage
            .page({ ...input, excluded: roster.map((item) => item.id) })
            .pipe(
              Effect.catch((error) =>
                error instanceof InvalidCursor
                  ? Effect.fail(new GuardError({ message: error.message }))
                  : Effect.die(error),
              ),
            )
          const items = yield* Effect.forEach(result.items, (item) =>
            Effect.gen(function* () {
              const definition: unknown = yield* Effect.try({
                try: () => JSON.parse(item.definition),
                catch: () => new Error("The retained definition is invalid."),
              }).pipe(Effect.orDie)
              const value = yield* Schema.decodeUnknownEffect(Archived)({
                version: 1,
                archivedAt: item.archived_at,
                definition,
              }).pipe(Effect.orDie)
              if (value.definition.id !== item.id)
                return yield* Effect.die(new Error("Archived definition identity mismatch."))
              return value
            }),
          )
          return { items, ...(result.next ? { next: result.next } : {}) }
        }),
      )

    const runsFor = Effect.fn("RayaTask.runs")(function* (id: string) {
      const raw = yield* deps.storage.read<unknown>(history(id)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed([])),
        Effect.orDie,
      )
      return yield* runs(raw).pipe(Effect.orDie)
    })

    const writeRuns = Effect.fn("RayaTask.writeRuns")(function* (id: string, items: Run[]) {
      const retained = new Set(
        items
          .filter((item) => !pending(item))
          .slice(-CAP)
          .map((item) => item.id),
      )
      const version = items.reduce((max, item) => Math.max(max, item.scheduleVersion ?? 1), 1)
      const anchor = consumed(items, version)
      if (anchor) retained.add(anchor.id)
      yield* deps.storage
        .replace(
          history(id),
          items.filter((item) => pending(item) || retained.has(item.id)),
        )
        .pipe(Effect.orDie)
    })

    const recall = Effect.fn("RayaTask.recall")(function* (id: string) {
      return yield* deps.storage.read<string>(memory(id)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed("")),
        Effect.orDie,
      )
    })

    const remember = Effect.fn("RayaTask.remember")(function* (id: string, text: string) {
      yield* deps.storage.replace(memory(id), text).pipe(Effect.orDie)
    })

    const append = Effect.fn("RayaTask.append")(function* (id: string, text: string) {
      const prior = yield* recall(id)
      yield* remember(id, [prior, text].filter(Boolean).join("\n\n").slice(-8000))
    })

    const output = Effect.fn("RayaTask.output")(function* (value: Output) {
      const parsed = yield* Schema.decodeUnknownEffect(Output)(value).pipe(
        Effect.mapError(
          () =>
            new GuardError({
              message: "Provide an output description and 1–20 named criteria with verification instructions.",
            }),
        ),
      )
      if (new Set(parsed.criteria.map((item) => item.id)).size !== parsed.criteria.length)
        return yield* new GuardError({ message: "Routine output criterion IDs must be unique." })
      return parsed
    })

    const create = Effect.fn("RayaTask.create")(function* (input: Create) {
      const schedule = yield* scheduled(input.schedule)
      const contract = input.output === undefined ? undefined : yield* output(input.output)
      const role = (input.role ?? "generalist").trim() || "generalist"
      const capabilities = input.capabilities ?? []
      if (sensitive.has(role.toLowerCase()) && !allowed(role, capabilities)) {
        return yield* new GuardError({
          kind: "capability",
          field: "capabilities",
          message: consent(role),
        })
      }
      const now = Date.now()
      const agent: Agent = {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        avatar: input.avatar,
        role,
        objective: input.objective.trim(),
        output: contract,
        capabilities,
        memoryScope: input.memoryScope ?? "role",
        schedule,
        scheduleVersion: 1,
        scheduleUpdatedAt: now,
        enabled: input.enabled ?? true,
        plan: input.plan,
        model: input.model,
        mode: input.mode?.trim() || undefined,
        dir: input.dir?.trim() || undefined,
        access: input.access ?? "brief",
        tools: input.tools,
        createdAt: now,
        updatedAt: now,
      }
      const items = yield* list()
      yield* save([...items, agent])
      return agent
    })

    const update = Effect.fn("RayaTask.update")(function* (
      id: string,
      patch: Partial<Create> & {
        enabled?: boolean
        note?: string
        expectedSchedule?: Schedule
        expectedScheduleVersion?: number
        expectedAccess?: "brief" | "full" | "unset"
        expectedOutput?: Output | "unset"
      },
    ) {
      const items = yield* list()
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return yield* new NotFoundError({ message: "Agent not found" })
      const prior = items[index]!
      if (patch.expectedOutput !== undefined && !isDeepStrictEqual(patch.expectedOutput, prior.output ?? "unset"))
        return yield* new GuardError({
          kind: "conflict",
          field: "output",
          message: "This routine's output requirements changed. Reload it before editing again.",
        })
      if (patch.expectedAccess !== undefined && patch.expectedAccess !== (prior.access ?? "unset"))
        return yield* new GuardError({
          kind: "conflict",
          field: "access",
          message: "This routine's access changed. Reload it before reviewing access again.",
        })
      if (patch.expectedScheduleVersion !== undefined && patch.expectedScheduleVersion !== (prior.scheduleVersion ?? 1))
        return yield* new GuardError({
          kind: "conflict",
          field: "schedule",
          message: "This routine's schedule version changed. Reload it and preview your changes again.",
        })
      if (patch.expectedSchedule && !isDeepStrictEqual(prior.schedule, patch.expectedSchedule))
        return yield* new GuardError({
          kind: "conflict",
          field: "schedule",
          message: "This routine's schedule changed. Reload it and preview your changes again.",
        })
      const schedule = patch.schedule ? yield* scheduled(patch.schedule) : prior.schedule
      const contract = patch.output === undefined ? prior.output : yield* output(patch.output)
      const changed = !isDeepStrictEqual(schedule, prior.schedule)
      const version = (prior.scheduleVersion ?? 1) + (changed ? 1 : 0)
      if (!Number.isSafeInteger(version))
        return yield* new GuardError({ message: "Routine schedule version limit reached." })
      const next: Agent = {
        ...prior,
        name: patch.name?.trim() || prior.name,
        role: patch.role?.trim() || prior.role,
        objective: patch.objective?.trim() || prior.objective,
        output: contract,
        capabilities: patch.capabilities ?? prior.capabilities,
        memoryScope: patch.memoryScope ?? prior.memoryScope,
        schedule,
        scheduleVersion: version,
        scheduleUpdatedAt: changed ? Date.now() : (prior.scheduleUpdatedAt ?? prior.createdAt),
        avatar: patch.avatar ?? prior.avatar,
        enabled: patch.enabled ?? prior.enabled,
        blockReset: patch.enabled === true ? (yield* runsFor(id)).map((run) => run.id) : prior.blockReset,
        plan: patch.plan ?? prior.plan,
        model: patch.model ?? prior.model,
        mode: patch.mode?.trim() || prior.mode,
        dir: patch.dir?.trim() || prior.dir,
        access: patch.access ?? prior.access,
        tools: patch.tools ?? prior.tools,
        note:
          patch.note ??
          (patch.enabled === true &&
          prior.note?.startsWith(`Paused after ${SAME} consecutive blocks for the same reason: `)
            ? undefined
            : prior.note),
        updatedAt: Date.now(),
      }
      if (sensitive.has(next.role.toLowerCase()) && !allowed(next.role, next.capabilities) && next.enabled) {
        return yield* new GuardError({
          kind: "capability",
          field: "capabilities",
          message: consent(next.role),
        })
      }
      const copy = [...items]
      copy[index] = next
      yield* save(copy)
      return next
    })

    const blocked = (agent: Agent, history: readonly Run[]) => {
      const ignored = new Set(agent.blockReset ?? [])
      const recent = history
        .filter((run) => (run.scheduleVersion ?? 1) === (agent.scheduleVersion ?? 1) && !ignored.has(run.id))
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(-SAME)
      const last = recent.at(-1)
      if (recent.length < SAME || !last?.blockedReason || pending(last)) return undefined
      if (!recent.every((run) => run.status === "blocked" && run.blockedReason === last.blockedReason)) return undefined
      return `Paused after ${SAME} consecutive blocks for the same reason: ${last.blockedReason}`
    }

    const launchable = Effect.fn("RayaTask.launchable")(function* (id: string) {
      const agent = yield* get(id)
      if (agent.access === undefined)
        return yield* new GuardError({
          kind: "access",
          field: "access",
          message: "Review this older routine's workspace access before starting another run.",
        })
      if (!agent.enabled) return yield* new GuardError({ kind: "paused", message: "This agent is paused." })
      const reason = blocked(agent, yield* runsFor(id))
      if (reason) return yield* new GuardError({ kind: "paused", message: reason })
      return agent
    })

    const enforce = Effect.fn("RayaTask.enforce")(function* (id: string) {
      const agent = yield* get(id)
      if (!agent.enabled) return
      const reason = blocked(agent, yield* runsFor(id))
      if (!reason) return
      yield* update(id, {
        expectedScheduleVersion: agent.scheduleVersion ?? 1,
        enabled: false,
        note: reason,
      })
    })

    const record = Effect.fn("RayaTask.record")(function* (input: Run) {
      const items = yield* runsFor(input.agentID)
      const prior = items.find((run) => run.id === input.id)
      if (prior && (prior.at !== input.at || prior.sessionID !== input.sessionID))
        return yield* Effect.die(new Error("A routine run cannot change its startup time or session."))
      if (prior && input.scheduleVersion !== undefined && input.scheduleVersion !== (prior.scheduleVersion ?? 1))
        return yield* Effect.die(new Error("A routine run cannot change its schedule version."))
      if (prior && input.trigger !== undefined && !isDeepStrictEqual(prior.trigger, input.trigger))
        return yield* Effect.die(new Error("A routine run cannot change its trigger evidence."))
      const trigger = prior?.trigger ?? input.trigger
      if (trigger) yield* Schema.decodeUnknownEffect(Trigger)(trigger).pipe(Effect.orDie)
      const revision = (prior?.revision ?? 0) + 1
      if (!Number.isSafeInteger(revision)) return yield* Effect.die(new Error("Routine run revision limit reached."))
      const version = prior?.scheduleVersion ?? input.scheduleVersion ?? 1
      if (!Number.isSafeInteger(version) || version < 1)
        return yield* Effect.die(new Error("Invalid routine schedule version."))
      const run: Run = { ...input, revision, scheduleVersion: version, ...(trigger ? { trigger } : {}) }
      const rest = items.filter((item) => item.id !== run.id)
      yield* writeRuns(run.agentID, [...rest, run])
      if (run.status !== "blocked" || !run.blockedReason || pending(run)) return run
      yield* enforce(run.agentID)
      return run
    })

    const restore = Effect.fn("RayaTask.restore")(function* (input: Run) {
      const prior = (yield* runsFor(input.agentID)).find((run) => run.id === input.id)
      if (prior) return prior
      return yield* record(input)
    })

    const transition = Effect.fn("RayaTask.transition")(function* (expected: Run, next: Run) {
      if (
        expected.id !== next.id ||
        expected.agentID !== next.agentID ||
        expected.sessionID !== next.sessionID ||
        (expected.scheduleVersion ?? 1) !== (next.scheduleVersion ?? 1) ||
        !isDeepStrictEqual(expected.trigger, next.trigger) ||
        expected.at !== next.at
      )
        return false
      const current = (yield* runsFor(expected.agentID)).find((run) => run.id === expected.id)
      if (!current || !isDeepStrictEqual(current, expected)) return false
      if (current.status === "complete" || current.status === "error") return false
      yield* record(next)
      return true
    })

    const evaluate = (agent: Agent, from: number, last?: Run) => {
      if (unzoned(agent.schedule))
        return Effect.succeed({
          nextRun: undefined,
          note: [
            "Automatic runs need timezone review. Edit the schedule, choose the intended timezone, and preview before saving. Existing run history is retained.",
            agent.note,
          ]
            .filter(Boolean)
            .join("\n"),
        })
      return (
        agent.enabled && agent.schedule.kind === "cron" && !pending(last)
          ? upcoming(
              agent.schedule.expr,
              Math.max(cursor(last) ?? agent.scheduleUpdatedAt ?? agent.createdAt, from - 60_000),
              agent.schedule.tz,
            )
          : Effect.try({ try: () => next(agent, from, last), catch: (err) => err })
      ).pipe(
        Effect.match({
          onSuccess: (at) => ({ nextRun: at, note: agent.note }),
          onFailure: (err) => {
            const message = err instanceof Error ? err.message : "Could not evaluate this schedule."
            log.warn("routine schedule could not be evaluated", { agentID: agent.id, message })
            return {
              nextRun: undefined,
              note: [`Schedule needs attention: ${message}`, agent.note].filter(Boolean).join("\n"),
            }
          },
        }),
      )
    }

    const occurrence = Effect.fn("RayaTask.occurrence")(function* (agent: Agent, from: number) {
      const history = yield* runsFor(agent.id)
      if (agent.access === undefined || history.some(pending) || blocked(agent, history)) return undefined
      const result = yield* evaluate(agent, from, consumed(history, agent.scheduleVersion ?? 1))
      return result.nextRun !== undefined && result.nextRun <= from ? result.nextRun : undefined
    })
    const eligible = (agent: Agent, from: number) => occurrence(agent, from).pipe(Effect.map((at) => at !== undefined))

    const ready = Effect.fn("RayaTask.ready")(function* (from: number) {
      const items = yield* list()
      const dueAgents: Agent[] = []
      for (const agent of items) {
        if (yield* eligible(agent, from)) dueAgents.push(agent)
      }
      return dueAgents
    })

    const dispatch = <A, E, R>(from: number, visit: (agent: Agent) => Effect.Effect<A, E, R>) =>
      list().pipe(
        Effect.flatMap((items) =>
          Effect.forEach(
            items,
            (agent) =>
              eligible(agent, from).pipe(
                Effect.flatMap((ready) => (ready ? visit(agent).pipe(Effect.asVoid) : Effect.void)),
              ),
            { concurrency: 4, discard: true },
          ),
        ),
      )

    const listenFor = Effect.fn("RayaTask.listenFor")(function* (source: string, filter?: string) {
      const items = yield* list()
      const match: Agent[] = []
      for (const agent of items) {
        if (!listen(agent, source, filter)) continue
        const history = yield* runsFor(agent.id)
        if (agent.access === undefined || history.some(pending) || blocked(agent, history)) continue
        match.push(agent)
      }
      return match
    })

    const preview = Effect.fn("RayaTask.preview")(function* (from: number) {
      const items = yield* list()
      const listed: Agent[] = []
      for (const agent of items) {
        const history = yield* runsFor(agent.id)
        if (agent.access === undefined) {
          listed.push({
            ...agent,
            nextRun: undefined,
            note: [
              "Access review required before future runs. Choose Review access to record your workspace-access choice.",
              agent.note,
            ]
              .filter(Boolean)
              .join("\n"),
          })
          continue
        }
        const reason = agent.enabled ? blocked(agent, history) : undefined
        if (reason) {
          listed.push({
            ...agent,
            enabled: false,
            nextRun: undefined,
            note: [reason, agent.note].filter(Boolean).join("\n"),
          })
          continue
        }
        const result = history.some(pending)
          ? { nextRun: undefined, note: agent.note }
          : yield* evaluate(agent, from, consumed(history, agent.scheduleVersion ?? 1))
        listed.push({ ...agent, ...result })
      }
      return listed
    })

    const remove = Effect.fn("RayaTask.remove")(function* (id: string) {
      if (!store)
        return yield* new GuardError({
          message: "The routine archive database is unavailable. Reconnect before removing routines.",
        })
      const items = yield* list()
      const found = items.find((item) => item.id === id)
      if (!found) return yield* new NotFoundError({ message: "Agent not found" })
      if ((yield* runsFor(id)).some(pending))
        return yield* new GuardError({ message: "This routine has unfinished runs. Resolve them before removing it." })
      if (deps.database && (yield* RayaTaskQueue.make(deps.database).active(id).pipe(Effect.orDie)).length)
        return yield* new GuardError({
          message: "This routine has scheduled work awaiting recovery. Resolve it before removing it.",
        })
      if (deps.database) {
        const { RayaTaskDelegation } = yield* Effect.promise(() => import("./delegation"))
        if ((yield* RayaTaskDelegation.make(deps.database).held(id)).length)
          return yield* new GuardError({
            message: "This routine has outstanding delegated requests. Stop them before removing it.",
          })
      }
      return { found, remaining: items.filter((item) => item.id !== id) }
    })

    return {
      list,
      page,
      get,
      runsFor,
      recall,
      ready,
      eligible,
      occurrence,
      dispatch,
      listenFor,
      preview,
      launchable,
      enforce: (id: string) => mutate(deps.storage, enforce(id)),
      create: (...args: Parameters<typeof create>) => mutate(deps.storage, create(...args)),
      update: (...args: Parameters<typeof update>) => mutate(deps.storage, update(...args)),
      remove: (id: string) =>
        mutate(
          deps.storage,
          claim(deps.storage, id, remove(id), (selected) =>
            retain(selected.found).pipe(
              Effect.andThen(removals(deps.storage).stage(id)),
              Effect.andThen(save(selected.remaining)),
              Effect.as(true),
            ),
          ),
        ),
      record: (...args: Parameters<typeof record>) => mutate(deps.storage, record(...args)),
      restore: (...args: Parameters<typeof restore>) => mutate(deps.storage, restore(...args)),
      transition: (...args: Parameters<typeof transition>) => mutate(deps.storage, transition(...args)),
      remember: (...args: Parameters<typeof remember>) => mutate(deps.storage, remember(...args)),
      append: (...args: Parameters<typeof append>) => mutate(deps.storage, append(...args)),
    }
  }

  function allowed(role: string, capabilities: readonly string[]) {
    const set = new Set(capabilities.map((item) => item.toLowerCase()))
    if (role.toLowerCase() === "accountant") return [...set].some((item) => money.has(item))
    if (role.toLowerCase() === "inbox") return [...set].some((item) => messages.has(item))
    return true
  }

  function consent(role: string) {
    if (role.toLowerCase() === "accountant") return "Accountant jobs need you to allow money records first."
    return "Inbox jobs need you to allow messages first."
  }
}
