import { Schema } from "effect"
import type { ProfileInfo } from "@/kilocode/browser/profile-schema"
import type { RayaTask } from "@/kilocode/task"
import type { RayaGoalHealth } from "@/kilocode/goal/health"
import type { Info as VoiceInfo } from "@/kilocode/voice/protocol"

export namespace RayaAdmin {
  export const Status = Schema.Literals(["healthy", "degraded", "blocked", "offline", "unknown"])
  export type Status = typeof Status.Type

  export const Subsystem = Schema.Literals([
    "runtime",
    "sessions",
    "goals",
    "routines",
    "organizations",
    "scheduler",
    "agents",
    "skills",
    "todos",
    "contacts",
    "browser",
    "computer",
    "voice",
    "memory",
    "canvas",
    "sync",
    "updates",
  ])
  export type Subsystem = typeof Subsystem.Type

  export const Reason = Schema.Literals([
    "ready",
    "connecting",
    "disconnected",
    "runtime-error",
    "storage-unreadable",
    "stream-error",
    "goal-blocked",
    "goal-state-unreadable",
    "goal-inventory-incomplete",
    "routine-blocked",
    "routine-recovery",
    "routine-history-unreadable",
    "agent-recovery",
    "browser-closed",
    "browser-unavailable",
    "browser-locked",
    "browser-error",
    "browser-auth-expired",
    "voice-unavailable",
    "voice-failed",
    "voice-incomplete",
    "not-checked",
    "probe-failed",
  ])
  export type Reason = typeof Reason.Type

  const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
  const Time = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
  export const Metrics = Schema.Struct({
    agents: Schema.optional(Count),
    goals: Schema.optional(Count),
    runs: Schema.optional(Count),
    active: Schema.optional(Count),
    blocked: Schema.optional(Count),
    recovering: Schema.optional(Count),
    failed: Schema.optional(Count),
    incomplete: Schema.optional(Count),
    paused: Schema.optional(Count),
  })
  export type Metrics = typeof Metrics.Type

  export const Row = Schema.Struct({
    id: Subsystem,
    status: Status,
    reason: Reason,
    observedAt: Time,
    metrics: Schema.optional(Metrics),
  })
  export type Row = typeof Row.Type

  const order: readonly Subsystem[] = [
    "runtime",
    "sessions",
    "goals",
    "routines",
    "organizations",
    "scheduler",
    "agents",
    "skills",
    "todos",
    "contacts",
    "browser",
    "computer",
    "voice",
    "memory",
    "canvas",
    "sync",
    "updates",
  ]

  export const Snapshot = Schema.Struct({
    format: Schema.Literal("raya.admin-health"),
    version: Schema.Literal(2),
    generatedAt: Time,
    items: Schema.Array(Row).check(
      Schema.makeFilter((items) =>
        items.length === order.length ? undefined : "Admin health must contain every subsystem.",
      ),
    ),
  })
  export type Snapshot = typeof Snapshot.Type

  export type Probe = {
    id: Subsystem
    read: (at: number) => Row | Promise<Row>
  }

  export async function collect(probes: readonly Probe[], clock = Date.now): Promise<Snapshot> {
    const at = clock()
    const map = new Map(probes.map((probe) => [probe.id, probe]))
    const items = await Promise.all(
      order.map(async (id): Promise<Row> => {
        const probe = map.get(id)
        if (!probe) return unknown(id, at, "not-checked")
        return Promise.resolve()
          .then(() => probe.read(at))
          .then(Schema.decodeUnknownPromise(Row))
          .then((row) => (row.id === id ? row : unknown(id, at, "probe-failed")))
          .catch(() => unknown(id, at, "probe-failed"))
      }),
    )
    return Schema.decodeUnknownPromise(Snapshot)({ format: "raya.admin-health", version: 2, generatedAt: at, items })
  }

  export function runtime(state: "connecting" | "connected" | "disconnected" | "error", at: number): Row {
    if (state === "connected") return row("runtime", "healthy", "ready", at)
    if (state === "connecting") return row("runtime", "unknown", "connecting", at)
    if (state === "disconnected") return row("runtime", "offline", "disconnected", at)
    return row("runtime", "offline", "runtime-error", at)
  }

  export function sessions(
    signal: {
      storage: "readable" | "unreadable" | "unknown"
      stream: "connecting" | "connected" | "disconnected" | "error"
    },
    at: number,
  ): Row {
    if (signal.stream === "connecting") return row("sessions", "unknown", "connecting", at)
    if (signal.stream === "disconnected") return row("sessions", "offline", "disconnected", at)
    if (signal.stream === "error") return row("sessions", "degraded", "stream-error", at)
    if (signal.storage === "unreadable") return row("sessions", "degraded", "storage-unreadable", at)
    if (signal.storage === "unknown") return unknown("sessions", at, "not-checked")
    return row("sessions", "healthy", "ready", at)
  }

  export function routines(
    agents: readonly Pick<RayaTask.Agent, "execution">[],
    histories: RayaTask.Histories,
    at: number,
  ): Row {
    const runs = histories.items.flatMap((item) => item.runs)
    const blocked = runs.filter((run) => run.status === "blocked").length
    const recovering = agents.filter((agent) => agent.execution?.state === "recovery").length
    const failed = runs.filter((run) => run.status === "error").length
    const metrics = bounded({ agents: agents.length, runs: runs.length, blocked, recovering, failed })
    if (histories.failed.length) return row("routines", "degraded", "routine-history-unreadable", at, metrics)
    if (recovering || failed) return row("routines", "degraded", "routine-recovery", at, metrics)
    if (blocked) return row("routines", "blocked", "routine-blocked", at, metrics)
    return row("routines", "healthy", "ready", at, metrics)
  }

  export function goals(signal: RayaGoalHealth.Summary, at: number): Row {
    const metrics = bounded(signal)
    if (signal.failed) return row("goals", "degraded", "goal-state-unreadable", at, metrics)
    if (signal.blocked) return row("goals", "blocked", "goal-blocked", at, metrics)
    if (signal.incomplete) return row("goals", "degraded", "goal-inventory-incomplete", at, metrics)
    return row("goals", "healthy", "ready", at, metrics)
  }

  export function browser(profile: Pick<typeof ProfileInfo.Type, "status"> | undefined, at: number): Row {
    if (!profile) return unknown("browser", at, "not-checked")
    if (profile.status === "ready") return row("browser", "healthy", "ready", at)
    if (profile.status === "locked") return row("browser", "blocked", "browser-locked", at)
    if (profile.status === "auth_expired") return row("browser", "blocked", "browser-auth-expired", at)
    if (profile.status === "closed") return row("browser", "offline", "browser-closed", at)
    if (profile.status === "unavailable") return row("browser", "offline", "browser-unavailable", at)
    return row("browser", "degraded", "browser-error", at)
  }

  export function agents(agents: readonly Pick<RayaTask.Agent, "execution">[], at: number): Row {
    const active = agents.filter(
      (agent) => agent.execution?.state === "starting" || agent.execution?.state === "active",
    ).length
    const recovering = agents.filter((agent) => agent.execution?.state === "recovery").length
    const metrics = bounded({ agents: agents.length, active, recovering })
    if (recovering) return row("agents", "degraded", "agent-recovery", at, metrics)
    return row("agents", "healthy", "ready", at, metrics)
  }

  export function voice(
    available: boolean,
    states: readonly { info: Pick<typeof VoiceInfo.Type, "status">; incomplete: boolean }[],
    at: number,
  ): Row {
    if (!available) return row("voice", "offline", "voice-unavailable", at)
    const active = states.filter((state) => state.info.status === "starting" || state.info.status === "active").length
    const failed = states.filter((state) => state.info.status === "failed").length
    const incomplete = states.filter((state) => state.incomplete).length
    const metrics = bounded({ active, failed, incomplete })
    if (failed) return row("voice", "degraded", "voice-failed", at, metrics)
    if (incomplete) return row("voice", "degraded", "voice-incomplete", at, metrics)
    return row("voice", "healthy", "ready", at, metrics)
  }

  export function ready(id: Subsystem, at: number) {
    return row(id, "healthy", "ready", at)
  }

  export function unavailable(id: Subsystem, at: number, reason: "disconnected" | "not-checked" = "not-checked") {
    return row(id, "unknown", reason, at)
  }

  function bounded(metrics: Metrics): Metrics {
    const cap = (value: number) => Math.min(value, 1_000_000)
    return {
      ...(metrics.agents === undefined ? {} : { agents: cap(metrics.agents) }),
      ...(metrics.goals === undefined ? {} : { goals: cap(metrics.goals) }),
      ...(metrics.runs === undefined ? {} : { runs: cap(metrics.runs) }),
      ...(metrics.active === undefined ? {} : { active: cap(metrics.active) }),
      ...(metrics.blocked === undefined ? {} : { blocked: cap(metrics.blocked) }),
      ...(metrics.recovering === undefined ? {} : { recovering: cap(metrics.recovering) }),
      ...(metrics.failed === undefined ? {} : { failed: cap(metrics.failed) }),
      ...(metrics.incomplete === undefined ? {} : { incomplete: cap(metrics.incomplete) }),
      ...(metrics.paused === undefined ? {} : { paused: cap(metrics.paused) }),
    }
  }

  function unknown(id: Subsystem, at: number, reason: "not-checked" | "probe-failed"): Row {
    return row(id, "unknown", reason, at)
  }

  function row(id: Subsystem, status: Status, reason: Reason, observedAt: number, metrics?: Metrics): Row {
    return { id, status, reason, observedAt, ...(metrics ? { metrics } : {}) }
  }
}
