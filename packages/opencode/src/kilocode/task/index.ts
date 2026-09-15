import { Effect, Exit, Schema } from "effect"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Criteria } from "@/kilocode/goal/criteria"
import { Permission } from "@/permission"
import { next as cronNext, parse as cronParse, upcoming } from "./cron"
import { mutate } from "./mutation"
import { local } from "./local"
import { claim, starting } from "./claim"
import { recover } from "./recovery"
import { owner, stopped } from "./owner"
import { removals } from "./removal"
import { archive as indexed, InvalidCursor } from "./archive"
import { RayaTaskQueue } from "./queue"
import { Create as OrganizationCreate, matchesDefinition } from "./organization"
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

  const Timestamp = Schema.Number.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
  const Provision = "organization:provision"
  export const Provisioning = Schema.Struct({
    enabled: Schema.Boolean,
    source: Schema.Literals(["user", "chat", "worker"]),
    actorID: Schema.optional(Schema.String),
    changedAt: Timestamp,
  })
  export const Authority = Schema.Struct({ enabled: Schema.Boolean, expected: Schema.Boolean })
  export const PathGrant = Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    access: Schema.Literals(["read", "write"]),
  })
  export type PathGrant = typeof PathGrant.Type
  export const PathAccess = Schema.Struct({
    version: Schema.Literal(1),
    grants: Schema.Array(PathGrant).check(Schema.isMaxLength(16)),
  })
  export type PathAccess = typeof PathAccess.Type

  export const Agent = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    avatar: Schema.optional(Schema.String),
    role: Schema.String,
    objective: Schema.String,
    output: Schema.optional(Output),
    capabilities: Schema.Array(Schema.String),
    provisioning: Schema.optional(Provisioning),
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
    paths: Schema.optional(PathAccess),
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
        recovery: Schema.optional(Schema.Literal("followup")),
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

  export const Histories = Schema.Struct({
    items: Schema.Array(Schema.Struct({ agentID: Schema.String, runs: Schema.Array(Run) })),
    failed: Schema.Array(Schema.String),
  })
  export type Histories = typeof Histories.Type

  const UsageReason = Schema.Literals([
    "run",
    "archive",
    "organization",
    "queue",
    "delegation",
    "inbox",
    "memory",
    "authority",
  ])
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
    paths: Schema.optional(PathAccess),
    access: Schema.optional(Schema.Literals(["full", "brief"])),
    tools: Schema.optional(Schema.Array(Schema.String)),
  })
  export type Create = typeof Create.Type

  const CAP = 50
  const MemorySource = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  const Memory = Schema.Struct({
    version: Schema.Literal(2),
    text: Schema.String,
    sources: Schema.Array(MemorySource).check(Schema.isMaxLength(CAP + 1)),
  })
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

  type Store = Pick<Storage.Interface, "read" | "replace" | "create" | "remove" | "list">
  const roster = ["raya", "agent"]
  const history = (id: string) => ["raya", "agent-runs", id]
  const memory = (id: string) => ["raya", "agent-memory", id]
  const staging = (id: string) => ["raya", "agent-stage", id]
  const agents = Schema.decodeUnknownEffect(Schema.Array(Agent))
  const runs = Schema.decodeUnknownEffect(Schema.Array(Run))
  const memories = Schema.decodeUnknownEffect(Memory)
  const StageV1 = Schema.Struct({
    version: Schema.Literal(1),
    agentID: Schema.String,
    organizationID: Schema.String,
    definition: Agent,
    owner: Schema.Struct({ host: Schema.String, pid: Schema.Int }),
    createdAt: Timestamp,
  })
  const StageV2 = Schema.Struct({
    ...StageV1.fields,
    version: Schema.Literal(2),
    desiredEnabled: Schema.Boolean,
    organization: OrganizationCreate,
    organizationRevision: Version,
  })
  const Stage = Schema.Union([StageV1, StageV2])

  function creation(value: typeof StageV2.Type): Create {
    return {
      name: value.definition.name,
      role: value.definition.role,
      objective: value.definition.objective,
      output: value.definition.output,
      capabilities: value.definition.capabilities,
      memoryScope: value.definition.memoryScope,
      schedule: value.definition.schedule,
      avatar: value.definition.avatar,
      enabled: value.desiredEnabled,
      plan: value.definition.plan,
      model: value.definition.model,
      mode: value.definition.mode,
      dir: value.definition.dir,
      paths: value.definition.paths,
      access: value.definition.access,
      tools: value.definition.tools,
    }
  }

  export function pending(run?: Run) {
    return run?.status === "running" || (run?.status === "blocked" && run.blockedReason === "waiting on you")
  }

  function slot(value: string) {
    const name = value.trim()
    if (!name || name === "chat") return
    return name
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

  function contains(parent: string, child: string) {
    const relative = path.relative(parent, child)
    return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  const scope = Effect.fn("RayaTask.paths")(function* (value?: PathAccess, dir?: string) {
    if (!value || value.grants.length === 0) return undefined
    const unique = new Map<string, PathGrant>()
    for (const item of value.grants) {
      const raw = item.path.trim()
      if (!path.isAbsolute(raw))
        return yield* new GuardError({
          kind: "access",
          field: "paths",
          message: "Choose absolute folders for Routine file access.",
        })
      const root = path.resolve(raw)
      const key = process.platform === "win32" ? root.toLowerCase() : root
      const prior = unique.get(key)
      unique.set(key, { path: root, access: prior?.access === "write" ? "write" : item.access })
    }
    const grants: PathGrant[] = []
    for (const item of [...unique.values()].sort(
      (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path),
    )) {
      const parent = grants.find((grant) => contains(grant.path, item.path))
      if (parent?.access === "write" || parent?.access === item.access) continue
      grants.push(item)
    }
    return {
      version: 1 as const,
      grants: dir ? grants.filter((item) => !contains(path.resolve(dir), item.path)) : grants,
    }
  })

  function scoped(permission: string, roots: string[], worktree: string) {
    const rules: ReturnType<typeof Permission.fromConfig> = [{ permission, pattern: "*", action: "deny" }]
    for (const root of roots) {
      const relative = path.relative(worktree, root).replaceAll("\\", "/")
      if (!relative) {
        rules.push({ permission, pattern: "*", action: "allow" })
        rules.push({ permission, pattern: "../**", action: "deny" })
        continue
      }
      rules.push({ permission, pattern: relative, action: "allow" })
      rules.push({ permission, pattern: `${relative}/**`, action: "allow" })
    }
    return rules
  }

  function external(roots: string[]) {
    const rules: ReturnType<typeof Permission.fromConfig> = [
      { permission: "external_directory", pattern: "*", action: "deny" },
    ]
    for (const root of roots) {
      const normalized = path.resolve(root).replaceAll("\\", "/")
      rules.push({ permission: "external_directory", pattern: normalized, action: "allow" })
      rules.push({ permission: "external_directory", pattern: `${normalized}/**`, action: "allow" })
    }
    return rules
  }

  function restrict(
    dir: string | undefined,
    paths: PathAccess | undefined,
    worktree: string | undefined,
    rules: ReturnType<typeof Permission.fromConfig>,
  ) {
    if (!dir?.trim() || !paths || !worktree?.trim()) return rules
    const read = [dir, ...paths.grants.map((item) => item.path)]
    return [
      ...rules,
      ...scoped("read", read, worktree),
      ...external(read),
      { permission: "bash", pattern: "*", action: "deny" as const },
      { permission: "background_process", pattern: "*", action: "deny" as const },
      { permission: "interactive_terminal", pattern: "*", action: "deny" as const },
      { permission: "lsp", pattern: "*", action: "deny" as const },
    ]
  }

  function confine(
    dir: string | undefined,
    paths: PathAccess | undefined,
    worktree: string | undefined,
    rules: ReturnType<typeof Permission.fromConfig>,
  ) {
    if (!dir?.trim()) return rules
    if (paths && worktree?.trim()) {
      const write = [dir, ...paths.grants.filter((item) => item.access === "write").map((item) => item.path)]
      return [
        ...restrict(dir, paths, worktree, rules),
        ...scoped("edit", write, worktree),
        ...scoped("write", write, worktree),
        ...scoped("apply_patch", write, worktree),
      ]
    }
    if (worktree?.trim()) {
      const relative = path.relative(worktree, dir).replaceAll("\\", "/")
      if (!relative)
        return [
          ...rules,
          { permission: "edit", pattern: "../**", action: "deny" as const },
          { permission: "write", pattern: "../**", action: "deny" as const },
          { permission: "apply_patch", pattern: "../**", action: "deny" as const },
        ]
      const pattern = `${relative}/**`
      return [
        ...rules,
        { permission: "edit", pattern: "*", action: "deny" as const },
        { permission: "write", pattern: "*", action: "deny" as const },
        { permission: "apply_patch", pattern: "*", action: "deny" as const },
        { permission: "edit", pattern, action: "allow" as const },
        { permission: "write", pattern, action: "allow" as const },
        { permission: "apply_patch", pattern, action: "allow" as const },
      ]
    }
    return [
      ...rules,
      { permission: "edit", pattern: "../**", action: "deny" as const },
      { permission: "write", pattern: "../**", action: "deny" as const },
      { permission: "apply_patch", pattern: "../**", action: "deny" as const },
    ]
  }

  export function rules(
    agent: Pick<Agent, "role" | "access" | "tools" | "dir" | "paths"> & Partial<Pick<Agent, "capabilities">>,
    worktree?: string,
  ) {
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
        "inspect_team",
      ]
      const selected =
        agent.tools !== undefined
          ? Permission.fromConfig(Object.fromEntries(agent.tools.map((tool) => [tool, "allow" as const])))
          : undefined
      for (const tool of reads) {
        if (!selected || Permission.evaluate(tool, "*", selected).action === "allow") cfg[tool] = "allow"
      }
      if (agent.capabilities?.some((item) => item.toLowerCase() === "organization:provision"))
        cfg.create_subordinate = "allow"
      return restrict(agent.dir, agent.paths, worktree, Permission.fromConfig(cfg))
    }
    if (agent.tools !== undefined) {
      const cfg: Record<string, "allow" | "deny"> = { "*": "deny", question: "allow" }
      for (const tool of agent.tools) cfg[tool] = "allow"
      if (agent.capabilities?.some((item) => item.toLowerCase() === "organization:provision"))
        cfg.create_subordinate = "allow"
      return confine(agent.dir, agent.paths, worktree, Permission.fromConfig(cfg))
    }
    return confine(
      agent.dir,
      agent.paths,
      worktree,
      Permission.fromConfig({ "*": "allow", edit: "allow", write: "allow", bash: "allow" }),
    )
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

    const histories = Effect.fn("RayaTask.histories")(function* () {
      const roster = yield* list()
      const results = yield* Effect.forEach(
        roster,
        (agent) =>
          runsFor(agent.id).pipe(
            Effect.exit,
            Effect.map((result) => ({ agentID: agent.id, result })),
          ),
        { concurrency: 8 },
      )
      return results.reduce<{ items: Array<{ agentID: string; runs: readonly Run[] }>; failed: string[] }>(
        (output, item) => {
          if (Exit.isSuccess(item.result)) output.items.push({ agentID: item.agentID, runs: item.result.value })
          else output.failed.push(item.agentID)
          return output
        },
        { items: [], failed: [] },
      )
    })

    const usage = Effect.fn("RayaTask.usage")(function* (id: string) {
      const agent = yield* get(id)
      const used: (typeof UsageReason.Type)[] = []
      const unavailable: (typeof UsageReason.Type)[] = []
      if (agent.provisioning !== undefined) used.push("authority")
      const history = yield* runsFor(id).pipe(Effect.exit)
      if (Exit.isFailure(history)) unavailable.push("run")
      else if (history.value.length) used.push("run")
      const note = yield* recall(id).pipe(Effect.exit)
      if (Exit.isFailure(note)) unavailable.push("memory")
      else if (note.value.length) used.push("memory")
      const legacy = yield* archives().pipe(Effect.exit)
      if (Exit.isFailure(legacy)) unavailable.push("archive")
      else if (legacy.value.some((item) => item.definition.id === id)) used.push("archive")
      if (!deps.database || !store) {
        unavailable.push("archive", "organization", "queue", "delegation", "inbox")
        return { used, unavailable }
      }
      const archived = yield* store.used(id).pipe(Effect.exit)
      if (Exit.isFailure(archived)) unavailable.push("archive")
      else if (archived.value && !used.includes("archive")) used.push("archive")
      const { RayaTaskOrganization } = yield* Effect.promise(() => import("./organization"))
      const organization = yield* RayaTaskOrganization.make(deps.database, { get }, deps.storage)
        .used(id)
        .pipe(Effect.exit)
      if (Exit.isFailure(organization) || !organization.value.complete) unavailable.push("organization")
      else if (organization.value.used) used.push("organization")
      const queued = yield* RayaTaskQueue.make(deps.database).used(id).pipe(Effect.exit)
      if (Exit.isFailure(queued)) unavailable.push("queue")
      else if (queued.value) used.push("queue")
      const { RayaTaskDelegation } = yield* Effect.promise(() => import("./delegation"))
      const delegated = yield* RayaTaskDelegation.make(deps.database).used(id).pipe(Effect.exit)
      if (Exit.isFailure(delegated)) unavailable.push("delegation")
      else if (delegated.value) used.push("delegation")
      const { RayaTaskInbox } = yield* Effect.promise(() => import("./inbox"))
      const inbox = yield* RayaTaskInbox.make(deps.database).used(id).pipe(Effect.exit)
      if (Exit.isFailure(inbox)) unavailable.push("inbox")
      else if (inbox.value) used.push("inbox")
      return { used, unavailable }
    })

    const cleanup = Effect.fn("RayaTask.cleanupStage")(function* (value: typeof StageV2.Type, key: string[]) {
      const database = deps.database
      if (!database) return false
      const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex")
      const proof = Effect.fn("RayaTask.cleanupProof")(function* () {
        const current = yield* receipt(value.agentID)
        if (!current || current.version !== 2 || !isDeepStrictEqual(current, value))
          return yield* new GuardError({ kind: "conflict", message: "This staged routine receipt changed." })
        const { RayaTaskOrganization } = yield* Effect.promise(() => import("./organization"))
        const organization = yield* RayaTaskOrganization.make(database, { get }, deps.storage)
          .get(value.organizationID)
          .pipe(Effect.catchTag("RayaTaskOrganization.NotFound", () => Effect.succeed(undefined)))
        if (organization)
          return yield* new GuardError({ kind: "conflict", message: "This staged routine now belongs to a company." })
        const items = yield* list()
        const agent = items.find((item) => item.id === value.agentID)
        if (!agent) return { items, found: false as const }
        if (!isDeepStrictEqual(agent, value.definition))
          return yield* new GuardError({ kind: "conflict", message: "This staged routine changed." })
        const evidence = yield* usage(value.agentID)
        if (evidence.used.length || evidence.unavailable.length)
          return yield* new GuardError({
            kind: "conflict",
            message: `This staged routine has retained or unavailable history: ${[
              ...evidence.used,
              ...evidence.unavailable.map((item) => `${item} unavailable`),
            ].join(", ")}.`,
          })
        return { items, found: true as const }
      })
      const erase = (input: Effect.Success<ReturnType<typeof proof>>) =>
        input.found
          ? removals(deps.storage)
              .stage(value.agentID)
              .pipe(Effect.andThen(save(input.items.filter((item) => item.id !== value.agentID))), Effect.as(true))
          : Effect.succeed(true)
      const recovered = yield* recover(
        deps.storage,
        value.agentID,
        (record) => Effect.succeed(record.operation === "cleanup" && record.intent === digest),
        () => proof().pipe(Effect.flatMap(erase)),
        (record) => {
          const current = owner()
          const local = record.owner.host === current.host && record.owner.pid === current.pid && !starting(record.id)
          return Effect.succeed(
            record.operation === "cleanup" && record.intent === digest && (local || stopped(record.owner)),
          )
        },
      )
      if (!recovered) yield* claim(deps.storage, value.agentID, proof(), erase, undefined, "cleanup", digest)
      yield* deps.storage.remove(key).pipe(Effect.orDie)
      return true
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

    const memoryState = Effect.fn("RayaTask.memoryState")(function* (id: string) {
      const raw = yield* deps.storage.read<unknown>(memory(id)).pipe(
        Effect.catchIf(
          (err) => Storage.NotFoundError.isInstance(err),
          () => Effect.succeed(undefined),
        ),
        Effect.orDie,
      )
      if (raw === undefined) return { version: 2 as const, text: "", sources: [] as string[] }
      if (typeof raw === "string") return { version: 2 as const, text: raw, sources: [] as string[] }
      return yield* memories(raw).pipe(Effect.orDie)
    })

    const recall = Effect.fn("RayaTask.recall")(function* (id: string) {
      return (yield* memoryState(id)).text
    })

    const remember = Effect.fn("RayaTask.remember")(function* (id: string, text: string) {
      const state = yield* memoryState(id)
      yield* deps.storage.replace(memory(id), { ...state, text }).pipe(Effect.orDie)
    })

    const append = Effect.fn("RayaTask.append")(function* (id: string, text: string) {
      const state = yield* memoryState(id)
      const value = [state.text, text].filter(Boolean).join("\n\n").slice(-8000)
      yield* deps.storage.replace(memory(id), { ...state, text: value }).pipe(Effect.orDie)
    })

    const learn = Effect.fn("RayaTask.learn")(function* (id: string, source: string, text: string) {
      const state = yield* memoryState(id)
      const key = createHash("sha256").update(source).digest("hex")
      if (state.sources.includes(key)) return
      const retained = new Set((yield* runsFor(id)).map((run) => createHash("sha256").update(run.id).digest("hex")))
      const sources = [...state.sources, key].filter((item) => retained.has(item))
      const value = [state.text, text].filter(Boolean).join("\n\n").slice(-8000)
      yield* deps.storage.replace(memory(id), { version: 2, text: value, sources }).pipe(Effect.orDie)
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

    const draft = Effect.fn("RayaTask.draft")(function* (input: Create, id: string) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        return yield* new GuardError({ message: "Routine ID is invalid." })
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
      const dir = input.dir?.trim() || undefined
      const accessPaths = yield* scope(input.paths, dir)
      if (accessPaths && !dir)
        return yield* new GuardError({
          kind: "access",
          field: "paths",
          message: "Choose a primary write folder before adding other folders.",
        })
      const agent: Agent = {
        id,
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
        dir,
        paths: accessPaths,
        access: input.access ?? "brief",
        tools: input.tools,
        createdAt: now,
        updatedAt: now,
      }
      return agent
    })

    const equivalent = Effect.fn("RayaTask.equivalent")(function* (existing: Agent, input: Create, id: string) {
      const agent = yield* draft(input, id)
      const expected = {
        ...agent,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        scheduleUpdatedAt: existing.scheduleUpdatedAt,
      }
      const saved = yield* Schema.decodeUnknownEffect(Agent)(JSON.parse(JSON.stringify(expected))).pipe(Effect.orDie)
      return isDeepStrictEqual(existing, saved)
    })

    const create = Effect.fn("RayaTask.create")(function* (input: Create, id = crypto.randomUUID(), replay = false) {
      const items = yield* list()
      const existing = items.find((item) => item.id === id)
      if (existing) {
        if (replay && (yield* equivalent(existing, input, id))) return existing
        return yield* new GuardError({ kind: "conflict", message: "A routine already uses this ID." })
      }
      const agent = yield* draft(input, id)
      yield* save([...items, agent])
      return agent
    })

    const receipt = Effect.fn("RayaTask.stageReceipt")(function* (id: string) {
      const raw = yield* deps.storage.read<unknown>(staging(id)).pipe(
        Effect.catchIf(
          (err) => Storage.NotFoundError.isInstance(err),
          () => Effect.succeed(undefined),
        ),
        Effect.orDie,
      )
      if (raw === undefined) return undefined
      return yield* Schema.decodeUnknownEffect(Stage)(raw).pipe(
        Effect.mapError(
          () => new GuardError({ kind: "conflict", message: "This routine's staging receipt is unreadable." }),
        ),
      )
    })

    const stage = Effect.fn("RayaTask.stage")(function* (
      input: Create,
      id: string,
      organizationID: string,
      organization?: typeof OrganizationCreate.Type,
      organizationRevision?: number,
    ) {
      const paused = { ...input, enabled: false }
      const saved = yield* Effect.gen(function* () {
        const prior = yield* receipt(id)
        if (prior) {
          const matches =
            prior.organizationID === organizationID &&
            (yield* equivalent(prior.definition, paused, id)) &&
            (prior.version === 1 ||
              (organization !== undefined &&
                organizationRevision === prior.organizationRevision &&
                isDeepStrictEqual(prior.organization, organization)))
          if (matches) return prior
          return yield* new GuardError({ kind: "conflict", message: "This routine belongs to another staging plan." })
        }
        const agent = yield* draft(paused, id)
        const value =
          organization && organizationRevision
            ? {
                version: 2 as const,
                agentID: id,
                organizationID,
                definition: agent,
                desiredEnabled: input.enabled ?? true,
                organization,
                organizationRevision,
                owner: owner(),
                createdAt: Date.now(),
              }
            : {
                version: 1 as const,
                agentID: id,
                organizationID,
                definition: agent,
                owner: owner(),
                createdAt: Date.now(),
              }
        if (yield* deps.storage.create(staging(id), value).pipe(Effect.orDie)) return value
        const current = yield* receipt(id)
        if (current?.organizationID === organizationID && (yield* equivalent(current.definition, paused, id))) {
          if (current.version === 1) return current
          if (
            organization !== undefined &&
            organizationRevision === current.organizationRevision &&
            isDeepStrictEqual(current.organization, organization)
          )
            return current
        }
        return yield* new GuardError({ kind: "conflict", message: "This routine belongs to another staging plan." })
      })
      const agent = saved.definition
      const items = yield* list()
      const existing = items.find((item) => item.id === id)
      if (existing) {
        if (isDeepStrictEqual(existing, agent) || (yield* equivalent(existing, input, id))) return existing
        return yield* new GuardError({ kind: "conflict", message: "A routine already uses this ID." })
      }
      yield* save([...items, agent])
      return agent
    })

    const activate = Effect.fn("RayaTask.activate")(function* (
      input: Create,
      id: string,
      organizationID: string,
      expected?: typeof OrganizationCreate.Type,
      expectedRevision?: number,
    ) {
      const items = yield* list()
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return yield* new NotFoundError({ message: "Agent not found" })
      const existing = items[index]
      if (!deps.database)
        return yield* new GuardError({ kind: "unavailable", message: "The organization database is unavailable." })
      const { RayaTaskOrganization } = yield* Effect.promise(() => import("./organization"))
      const organization = yield* RayaTaskOrganization.make(deps.database, { get }, deps.storage)
        .get(organizationID)
        .pipe(
          Effect.catchTag("RayaTaskOrganization.NotFound", () =>
            Effect.fail(new GuardError({ kind: "conflict", message: "The staged routine's organization is missing." })),
          ),
        )
      if (!organization.members.some((item) => item.agentID === id))
        return yield* new GuardError({ kind: "conflict", message: "The staged routine is not in its organization." })
      const prior = yield* receipt(id)
      if (!prior) {
        if (
          expected !== undefined &&
          (organization.revision !== expectedRevision || !matchesDefinition(organization, expected))
        )
          return yield* new GuardError({ kind: "conflict", message: "The staged routine's organization changed." })
        if (yield* equivalent(existing, input, id)) return existing
        return yield* new GuardError({ kind: "conflict", message: "This routine's staging receipt is missing." })
      }
      if (
        prior.organizationID !== organizationID ||
        !(yield* equivalent(prior.definition, { ...input, enabled: false }, id)) ||
        (prior.version === 2 &&
          (expected === undefined ||
            expectedRevision !== prior.organizationRevision ||
            organization.revision !== prior.organizationRevision ||
            !isDeepStrictEqual(prior.organization, expected) ||
            !matchesDefinition(organization, prior.organization)))
      )
        return yield* new GuardError({ kind: "conflict", message: "This routine belongs to another staging plan." })
      if (!(yield* equivalent(existing, { ...input, enabled: false }, id)) && !(yield* equivalent(existing, input, id)))
        return yield* new GuardError({
          kind: "conflict",
          message: "This provisioned routine changed before activation.",
        })
      const next: Agent = (input.enabled ?? true) ? { ...existing, enabled: true, updatedAt: Date.now() } : existing
      const copy = [...items]
      copy[index] = next
      yield* save(copy)
      yield* deps.storage.remove(staging(id)).pipe(Effect.orDie)
      return next
    })

    const recoverStages = Effect.fn("RayaTask.recoverStages")(function* () {
      const keys = (yield* deps.storage.list(["raya", "agent-stage"]).pipe(Effect.orDie)).sort((a, b) =>
        a.join("/").localeCompare(b.join("/")),
      )
      const issues: string[] = []
      let recovered = 0
      let pending = 0
      const totals = new Map<string, number>()
      const groups = new Map<string, Array<{ value: typeof StageV2.Type; agent: Agent }>>()
      const opaque = new Set<string>()
      for (const key of keys.slice(0, 1_024)) {
        if (key.length !== 3 || key[0] !== "raya" || key[1] !== "agent-stage") {
          issues.push(`Unreadable staged-worker key: ${key.join("/")}`)
          continue
        }
        const raw = yield* deps.storage.read<unknown>(key).pipe(Effect.exit)
        if (Exit.isFailure(raw)) {
          if (key[2]) opaque.add(key[2])
          issues.push(`Could not read staged worker ${key[2]}.`)
          continue
        }
        const decoded = yield* Schema.decodeUnknownEffect(Stage)(raw.value).pipe(Effect.exit)
        if (Exit.isFailure(decoded) || decoded.value.agentID !== key[2]) {
          if (key[2]) opaque.add(key[2])
          issues.push(`Staged worker ${key[2]} has an unreadable receipt.`)
          continue
        }
        const value = decoded.value
        totals.set(value.organizationID, (totals.get(value.organizationID) ?? 0) + 1)
        if (!stopped(value.owner)) {
          pending++
          continue
        }
        const agent = yield* get(value.agentID).pipe(
          Effect.catchTag("RayaTask.NotFoundError", () => Effect.succeed(undefined)),
        )
        if (!deps.database) {
          issues.push(`Staged worker ${value.agentID} cannot be reconciled without the organization database.`)
          continue
        }
        const { RayaTaskOrganization } = yield* Effect.promise(() => import("./organization"))
        const organization = yield* RayaTaskOrganization.make(deps.database, { get }, deps.storage)
          .get(value.organizationID)
          .pipe(Effect.catchTag("RayaTaskOrganization.NotFound", () => Effect.succeed(undefined)))
        if (value.version === 2 && !organization) {
          const cleaned = yield* cleanup(value, key).pipe(Effect.exit)
          if (Exit.isSuccess(cleaned) && cleaned.value) {
            recovered++
            continue
          }
          if (agent) issues.push(`Staged worker ${value.agentID} could not prove that cleanup is safe.`)
          else issues.push(`Staged worker ${value.agentID} has an interrupted cleanup that requires review.`)
          continue
        }
        if (!agent && !organization) {
          yield* deps.storage.remove(key).pipe(Effect.orDie)
          recovered++
          continue
        }
        if (!agent || !organization || organization.archived) {
          issues.push(`Staged worker ${value.agentID} requires review before recovery.`)
          continue
        }
        const member = organization.members.some((item) => item.agentID === value.agentID)
        if (
          value.version === 2 &&
          member &&
          organization.revision === value.organizationRevision &&
          matchesDefinition(organization, value.organization)
        ) {
          const planned = creation(value)
          const disabled = yield* equivalent(agent, { ...planned, enabled: false }, value.agentID)
          const desired = yield* equivalent(agent, planned, value.agentID)
          if (disabled || desired) {
            groups.set(value.organizationID, [...(groups.get(value.organizationID) ?? []), { value, agent }])
            continue
          }
        }
        const expected = { ...value.definition, enabled: true, updatedAt: agent.updatedAt }
        if (value.version === 1 && member && agent.enabled && isDeepStrictEqual(agent, expected)) {
          yield* deps.storage.remove(key).pipe(Effect.orDie)
          recovered++
          continue
        }
        issues.push(`Staged worker ${value.agentID} remains disabled or changed and requires review.`)
      }
      for (const [organizationID, group] of groups) {
        const obscured = group[0]?.value.organization.members.some((item) => opaque.has(item.agentID)) ?? true
        if (group.length !== totals.get(organizationID) || obscured) {
          issues.push(`Staged organization ${organizationID} has incomplete or live worker receipts.`)
          continue
        }
        for (const item of group) {
          const planned = creation(item.value)
          yield* activate(
            planned,
            item.value.agentID,
            organizationID,
            item.value.organization,
            item.value.organizationRevision,
          )
          recovered++
        }
      }
      return { recovered, pending, issues, truncated: keys.length > 1_024 }
    })

    const update = Effect.fn("RayaTask.update")(function* (
      id: string,
      patch: Partial<Create> & {
        enabled?: boolean
        note?: string
        expectedSchedule?: Schedule
        expectedScheduleVersion?: number
        expectedAccess?: "brief" | "full" | "unset"
        expectedTools?: readonly string[] | "unset"
        expectedPaths?: PathAccess | "unset"
        expectedOutput?: Output | "unset"
        expectedProvisioning?: boolean
        provisioning?: typeof Provisioning.Type
      },
    ) {
      const items = yield* list()
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return yield* new NotFoundError({ message: "Agent not found" })
      const prior = items[index]!
      const provisioning = prior.capabilities.some((item) => item.toLowerCase() === Provision)
      if (patch.expectedProvisioning !== undefined && patch.expectedProvisioning !== provisioning)
        return yield* new GuardError({
          kind: "conflict",
          field: "capabilities",
          message: "This worker's creation authority changed. Reload the organization before editing again.",
        })
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
      if (patch.expectedTools !== undefined && !isDeepStrictEqual(patch.expectedTools, prior.tools ?? "unset"))
        return yield* new GuardError({
          kind: "conflict",
          field: "tools",
          message: "This routine's tool access changed. Reload it before reviewing access again.",
        })
      if (patch.expectedPaths !== undefined && !isDeepStrictEqual(patch.expectedPaths, prior.paths ?? "unset"))
        return yield* new GuardError({
          kind: "conflict",
          field: "paths",
          message: "This routine's folder access changed. Reload it before reviewing access again.",
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
      const dir = patch.dir?.trim() || prior.dir
      const schedule = patch.schedule ? yield* scheduled(patch.schedule) : prior.schedule
      const contract = patch.output === undefined ? prior.output : yield* output(patch.output)
      const accessPaths = patch.paths === undefined ? prior.paths : yield* scope(patch.paths, dir)
      if (accessPaths && !dir)
        return yield* new GuardError({
          kind: "access",
          field: "paths",
          message: "Choose a primary write folder before adding other folders.",
        })
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
        provisioning: patch.provisioning ?? prior.provisioning,
        memoryScope: patch.memoryScope ?? prior.memoryScope,
        schedule,
        scheduleVersion: version,
        scheduleUpdatedAt: changed ? Date.now() : (prior.scheduleUpdatedAt ?? prior.createdAt),
        avatar: patch.avatar ?? prior.avatar,
        enabled: patch.enabled ?? prior.enabled,
        blockReset: patch.enabled === true ? (yield* runsFor(id)).map((run) => run.id) : prior.blockReset,
        plan: patch.plan === undefined ? prior.plan : patch.plan.trim() || undefined,
        model: patch.model ?? prior.model,
        mode: patch.mode === undefined ? prior.mode : slot(patch.mode),
        dir,
        paths: accessPaths,
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

    const authority = Effect.fn("RayaTask.authority")(function* (
      id: string,
      input: typeof Authority.Type,
      source: (typeof Provisioning.Type)["source"],
      actorID?: string,
    ) {
      const value = yield* Schema.decodeUnknownEffect(Authority)(input).pipe(
        Effect.mapError(
          () => new GuardError({ kind: "capability", message: "Choose whether this worker can create workers." }),
        ),
      )
      const items = yield* list()
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return yield* new NotFoundError({ message: "Agent not found" })
      const prior = items[index]!
      const current = prior.capabilities.some((item) => item.toLowerCase() === Provision)
      if (current === value.enabled && prior.provisioning?.enabled === value.enabled) return prior
      if (current !== value.expected)
        return yield* new GuardError({
          kind: "conflict",
          field: "capabilities",
          message: "This worker's creation authority changed. Reload the organization before editing again.",
        })
      const capabilities = value.enabled
        ? [...prior.capabilities, ...(current ? [] : [Provision])]
        : prior.capabilities.filter((item) => item.toLowerCase() !== Provision)
      return yield* update(id, {
        capabilities,
        provisioning: { enabled: value.enabled, source, ...(actorID ? { actorID } : {}), changedAt: Date.now() },
        expectedProvisioning: value.expected,
      })
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
        const { RayaTaskOrganization } = yield* Effect.promise(() => import("./organization"))
        const organization = RayaTaskOrganization.make(deps.database, { get }, deps.storage)
        if (yield* organization.hasActive(id))
          return yield* new GuardError({
            message:
              "This routine belongs to an active organization. Archive or update that organization before removing it.",
          })
      }
      return { found, remaining: items.filter((item) => item.id !== id) }
    })

    const erase = (selected: Effect.Success<ReturnType<typeof remove>>) =>
      retain(selected.found).pipe(
        Effect.andThen(removals(deps.storage).stage(selected.found.id)),
        Effect.andThen(save(selected.remaining)),
        Effect.as(true),
      )

    const removeOwned = Effect.fn("RayaTask.removeOwned")(function* (id: string) {
      const recovered = yield* recover(
        deps.storage,
        id,
        (record) => Effect.succeed(record.operation === "remove"),
        () =>
          Effect.gen(function* () {
            const items = yield* list()
            if (!items.some((item) => item.id === id)) return true
            yield* erase(yield* remove(id))
            return true
          }),
        (record) => {
          const current = owner()
          const local = record.owner.host === current.host && record.owner.pid === current.pid && !starting(record.id)
          return Effect.succeed(record.operation === "remove" && (local || stopped(record.owner)))
        },
      )
      if (recovered) return true
      return yield* claim(deps.storage, id, remove(id), erase, undefined, "remove")
    })

    return {
      list,
      page,
      get,
      runsFor,
      histories,
      usage,
      recall,
      ready,
      eligible,
      occurrence,
      dispatch,
      listenFor,
      preview,
      launchable,
      enforce: (id: string) => mutate(deps.storage, enforce(id)),
      check: (input: Create) => draft(input, crypto.randomUUID()).pipe(Effect.asVoid),
      create: (input: Create) => mutate(deps.storage, create(input)),
      provision: (input: Create, id: string) => mutate(deps.storage, create(input, id, true)),
      stage: (
        input: Create,
        id: string,
        organizationID: string,
        organization?: typeof OrganizationCreate.Type,
        revision?: number,
      ) => mutate(deps.storage, stage(input, id, organizationID, organization, revision)),
      activate: (
        input: Create,
        id: string,
        organizationID: string,
        organization?: typeof OrganizationCreate.Type,
        revision?: number,
      ) => mutate(deps.storage, activate(input, id, organizationID, organization, revision)),
      recoverStages: () => mutate(deps.storage, recoverStages(), "Routine staging"),
      update: (...args: Parameters<typeof update>) => mutate(deps.storage, update(...args)),
      authority: (...args: Parameters<typeof authority>) => mutate(deps.storage, authority(...args)),
      remove: (id: string) => mutate(deps.storage, removeOwned(id)),
      record: (...args: Parameters<typeof record>) => mutate(deps.storage, record(...args)),
      restore: (...args: Parameters<typeof restore>) => mutate(deps.storage, restore(...args)),
      transition: (...args: Parameters<typeof transition>) => mutate(deps.storage, transition(...args)),
      remember: (...args: Parameters<typeof remember>) => mutate(deps.storage, remember(...args)),
      append: (...args: Parameters<typeof append>) => mutate(deps.storage, append(...args)),
      learn: (...args: Parameters<typeof learn>) => mutate(deps.storage, learn(...args)),
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
