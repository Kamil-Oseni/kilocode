import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { next as cronNext } from "./cron"

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

  export const Agent = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    avatar: Schema.optional(Schema.String),
    role: Schema.String,
    objective: Schema.String,
    capabilities: Schema.Array(Schema.String),
    memoryScope: Schema.Literals(["role", "project", "session"]),
    schedule: Schedule,
    enabled: Schema.Boolean,
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
  })
  export type Agent = typeof Agent.Type

  export const Outcome = Schema.Struct({
    kind: Schema.Literals(["code", "notify"]),
    summary: Schema.String,
    evidence: Schema.optional(Schema.Array(Schema.String)),
    cost: Schema.Number,
  })
  export type Outcome = typeof Outcome.Type

  export const Run = Schema.Struct({
    id: Schema.String,
    agentID: Schema.String,
    at: Schema.Number,
    sessionID: SessionID,
    status: Schema.Literals(["running", "complete", "blocked", "error"]),
    outcome: Schema.optional(Outcome),
    blockedReason: Schema.optional(Schema.String),
  })
  export type Run = typeof Run.Type

  export const Create = Schema.Struct({
    name: Schema.String,
    role: Schema.optional(Schema.String),
    objective: Schema.String,
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
  }) {}

  export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("RayaTask.NotFoundError", {
    message: Schema.String,
  }) {}

  type Store = Pick<Storage.Interface, "read" | "write">
  const roster = ["raya", "agent"]
  const history = (id: string) => ["raya", "agent-runs", id]
  const memory = (id: string) => ["raya", "agent-memory", id]
  const agents = Schema.decodeUnknownEffect(Schema.Array(Agent))
  const runs = Schema.decodeUnknownEffect(Schema.Array(Run))

  export function next(agent: Agent, from: number, last?: Run) {
    if (!agent.enabled) return
    if (agent.schedule.kind === "manual") return
    if (agent.schedule.kind === "event") return
    if (last?.status === "running") return
    if (agent.schedule.kind === "once") {
      if (last) return
      return agent.schedule.at
    }
    const origin = last?.at ?? agent.createdAt
    return cronNext(agent.schedule.expr, Math.max(origin, from - 60_000))
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
    if (agent.tools?.length) {
      const cfg: Record<string, "allow" | "deny"> = { "*": "deny", question: "allow" }
      for (const tool of agent.tools) cfg[tool] = "allow"
      return Permission.fromConfig(cfg)
    }
    if (brief(agent)) {
      return Permission.fromConfig({ edit: "deny", write: "deny", bash: "deny", apply_patch: "deny" })
    }
    return Permission.fromConfig({ "*": "allow", edit: "allow", write: "allow", bash: "allow" })
  }

  export function listen(agent: Agent, source: string, filter?: string) {
    if (!agent.enabled) return false
    if (agent.schedule.kind !== "event") return false
    if (agent.schedule.source !== source) return false
    if (agent.schedule.filter && filter && agent.schedule.filter !== filter) return false
    return true
  }

  export function make(deps: { storage: Store }) {
    const list = Effect.fn("RayaTask.list")(function* () {
      const raw = yield* deps.storage.read<unknown>([...roster]).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed([])),
        Effect.orDie,
      )
      return yield* agents(raw).pipe(Effect.orDie)
    })

    const save = Effect.fn("RayaTask.save")(function* (items: Agent[]) {
      yield* deps.storage.write([...roster], items).pipe(Effect.orDie)
    })

    const get = Effect.fn("RayaTask.get")(function* (id: string) {
      const items = yield* list()
      const found = items.find((item) => item.id === id)
      if (!found) return yield* new NotFoundError({ message: "Agent not found" })
      return found
    })

    const runsFor = Effect.fn("RayaTask.runs")(function* (id: string) {
      const raw = yield* deps.storage.read<unknown>(history(id)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed([])),
        Effect.orDie,
      )
      return yield* runs(raw).pipe(Effect.orDie)
    })

    const writeRuns = Effect.fn("RayaTask.writeRuns")(function* (id: string, items: Run[]) {
      yield* deps.storage.write(history(id), items.slice(-CAP)).pipe(Effect.orDie)
    })

    const recall = Effect.fn("RayaTask.recall")(function* (id: string) {
      return yield* deps.storage.read<string>(memory(id)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed("")),
        Effect.orDie,
      )
    })

    const remember = Effect.fn("RayaTask.remember")(function* (id: string, text: string) {
      yield* deps.storage.write(memory(id), text).pipe(Effect.orDie)
    })

    const create = Effect.fn("RayaTask.create")(function* (input: Create) {
      const role = (input.role ?? "generalist").trim() || "generalist"
      const capabilities = input.capabilities ?? []
      if (sensitive.has(role.toLowerCase()) && !allowed(role, capabilities)) {
        return yield* new GuardError({
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
        capabilities,
        memoryScope: input.memoryScope ?? "role",
        schedule: input.schedule,
        enabled: input.enabled ?? true,
        plan: input.plan,
        model: input.model,
        mode: input.mode?.trim() || undefined,
        dir: input.dir?.trim() || undefined,
        access: input.access ?? (role.toLowerCase() === "briefer" ? "brief" : "full"),
        tools: input.tools,
        createdAt: now,
        updatedAt: now,
      }
      const items = yield* list()
      yield* save([...items, agent])
      return agent
    })

    const update = Effect.fn("RayaTask.update")(function* (id: string, patch: Partial<Create> & { enabled?: boolean; note?: string }) {
      const items = yield* list()
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return yield* new NotFoundError({ message: "Agent not found" })
      const prior = items[index]!
      const next: Agent = {
        ...prior,
        name: patch.name?.trim() || prior.name,
        role: patch.role?.trim() || prior.role,
        objective: patch.objective?.trim() || prior.objective,
        capabilities: patch.capabilities ?? prior.capabilities,
        memoryScope: patch.memoryScope ?? prior.memoryScope,
        schedule: patch.schedule ?? prior.schedule,
        avatar: patch.avatar ?? prior.avatar,
        enabled: patch.enabled ?? prior.enabled,
        plan: patch.plan ?? prior.plan,
        model: patch.model ?? prior.model,
        mode: patch.mode?.trim() || prior.mode,
        dir: patch.dir?.trim() || prior.dir,
        access: patch.access ?? prior.access,
        tools: patch.tools ?? prior.tools,
        note: patch.note ?? prior.note,
        updatedAt: Date.now(),
      }
      if (sensitive.has(next.role.toLowerCase()) && !allowed(next.role, next.capabilities) && next.enabled) {
        return yield* new GuardError({
          message: consent(next.role),
        })
      }
      const copy = [...items]
      copy[index] = next
      yield* save(copy)
      return next
    })

    const record = Effect.fn("RayaTask.record")(function* (run: Run) {
      const items = yield* runsFor(run.agentID)
      const rest = items.filter((item) => item.id !== run.id)
      yield* writeRuns(run.agentID, [...rest, run])
      if (run.status !== "blocked" || !run.blockedReason) return run
      const recent = [...rest, run].filter((item) => item.status === "blocked").slice(-SAME)
      if (recent.length < SAME) return run
      if (!recent.every((item) => item.blockedReason === run.blockedReason)) return run
      yield* update(run.agentID, {
        enabled: false,
        note: `Paused after ${SAME} blocks for the same reason: ${run.blockedReason}`,
      }).pipe(Effect.catch(() => Effect.void))
      return run
    })

    const ready = Effect.fn("RayaTask.ready")(function* (from: number) {
      const items = yield* list()
      const dueAgents: Agent[] = []
      for (const agent of items) {
        const historyItems = yield* runsFor(agent.id)
        const last = historyItems.at(-1)
        if (due(agent, from, last) !== undefined) dueAgents.push(agent)
      }
      return dueAgents
    })

    const listenFor = Effect.fn("RayaTask.listenFor")(function* (source: string, filter?: string) {
      const items = yield* list()
      const match: Agent[] = []
      for (const agent of items) {
        if (!listen(agent, source, filter)) continue
        const last = (yield* runsFor(agent.id)).at(-1)
        if (last?.status === "running") continue
        match.push(agent)
      }
      return match
    })

    const preview = Effect.fn("RayaTask.preview")(function* (from: number) {
      const items = yield* list()
      const listed: Agent[] = []
      for (const agent of items) {
        const last = (yield* runsFor(agent.id)).at(-1)
        listed.push({ ...agent, nextRun: next(agent, from, last) })
      }
      return listed
    })

    const remove = Effect.fn("RayaTask.remove")(function* (id: string) {
      const items = yield* list()
      const found = items.find((item) => item.id === id)
      if (!found) return yield* new NotFoundError({ message: "Agent not found" })
      yield* save(items.filter((item) => item.id !== id))
      yield* writeRuns(id, [])
      yield* remember(id, "")
      return true
    })

    return { list, get, create, update, remove, runsFor, record, recall, remember, ready, listenFor, preview }
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
