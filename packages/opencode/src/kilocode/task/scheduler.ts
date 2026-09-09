import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { RayaTaskQueue } from "./queue"
import { mutate } from "./mutation"
import { removals } from "./removal"

type Timer = Extract<RayaTask.Trigger, { kind: "timer" }>
type Row = NonNullable<Effect.Success<ReturnType<ReturnType<typeof RayaTaskQueue.make>["get"]>>>
const owner = crypto.randomUUID()
const ttl = 180_000
const timer = (row: Row): Timer => ({
  kind: "timer",
  id: row.id,
  scheduledAt: row.scheduled_at,
  observedAt: row.observed_at,
  ...(row.timezone ? { tz: row.timezone } : {}),
})

export function scheduler(input: { database: Database.Interface; storage: Storage.Interface }) {
  const queue = RayaTaskQueue.make(input.database)
  const tasks = RayaTask.make(input)
  const clean = () =>
    mutate(
      input.storage,
      Effect.gen(function* () {
        const receipts = removals(input.storage)
        const pending = yield* receipts.pending()
        if (!pending.length) return
        const roster = new Set((yield* tasks.list(true)).map((item) => item.id))
        const ids = pending
          .filter((item) => !roster.has(item.agentID))
          .slice(0, 256)
          .map((item) => item.agentID)
        if (!ids.length) return
        for (const id of ids) yield* queue.discard(id).pipe(Effect.orDie)
        yield* receipts.finish(ids)
      }),
    )
  const retire = (id: string) =>
    mutate(
      input.storage,
      Effect.gen(function* () {
        const item = yield* tasks.get(id)
        yield* queue.retire(id, item.scheduleVersion ?? 1).pipe(Effect.orDie)
      }),
    )
  const prepare = Effect.fn("RayaTaskScheduler.prepare")(function* (id: string, from: number) {
    const item = yield* tasks.get(id)
    if (RayaTask.unzoned(item.schedule)) return undefined
    if (!item.enabled || (item.schedule.kind !== "once" && item.schedule.kind !== "cron")) return undefined
    const existing = yield* queue.pending(id, item.scheduleVersion ?? 1).pipe(Effect.orDie)
    const at = existing.length ? undefined : yield* tasks.occurrence(item, from)
    return yield* mutate(
      input.storage,
      Effect.gen(function* () {
        const fresh = yield* tasks.get(id)
        if (RayaTask.unzoned(fresh.schedule)) return undefined
        if (!fresh.enabled || (fresh.scheduleVersion ?? 1) !== (item.scheduleVersion ?? 1)) return undefined
        const history = yield* tasks.runsFor(id)
        if (history.some(RayaTask.pending) || (yield* queue.active(id).pipe(Effect.orDie)).length) return undefined
        const rows = yield* queue.pending(id, fresh.scheduleVersion ?? 1).pipe(Effect.orDie)
        for (const row of rows) {
          if (RayaTask.recorded(fresh, history, row.scheduled_at)) {
            yield* queue.skip(row.id, "Already consumed by recorded run history.").pipe(Effect.orDie)
            continue
          }
          return timer(row)
        }
        if (at === undefined || RayaTask.recorded(fresh, history, at)) return undefined
        const cursor = yield* queue.cursor(id, fresh.scheduleVersion ?? 1).pipe(Effect.orDie)
        if (cursor && cursor.through >= at) return undefined
        const tz =
          fresh.schedule.kind === "cron"
            ? (fresh.schedule.tz ?? new Intl.DateTimeFormat().resolvedOptions().timeZone)
            : undefined
        yield* queue
          .publish({
            agentID: id,
            version: fresh.scheduleVersion ?? 1,
            expected: cursor?.through,
            occurrences: [{ at, observedAt: from, tz }],
          })
          .pipe(Effect.orDie)
        const row = (yield* queue.pending(id, fresh.scheduleVersion ?? 1).pipe(Effect.orDie))[0]
        return row ? timer(row) : undefined
      }),
    )
  })
  const check = Effect.fn("RayaTaskScheduler.check")(function* (item: RayaTask.Agent, trigger: Timer) {
    if (RayaTask.unzoned(item.schedule))
      return yield* new RayaTask.GuardError({
        kind: "schedule",
        field: "timezone",
        message:
          "Automatic runs need timezone review. Edit this routine's schedule and choose its intended timezone before starting queued work.",
      })
    const row = yield* queue.get(trigger.id).pipe(Effect.orDie)
    const history = yield* tasks.runsFor(item.id)
    if (
      !row ||
      row.agent_id !== item.id ||
      row.schedule_version !== (item.scheduleVersion ?? 1) ||
      row.state !== "queued" ||
      !item.enabled ||
      (item.schedule.kind !== "once" && item.schedule.kind !== "cron") ||
      history.some(RayaTask.pending) ||
      RayaTask.recorded(item, history, row.scheduled_at) ||
      (yield* queue.active(item.id).pipe(Effect.orDie)).length
    )
      return yield* new RayaTask.GuardError({ message: "This queued occurrence is no longer available for startup." })
    return timer(row)
  })
  const reserve = Effect.fn("RayaTaskScheduler.reserve")(function* (trigger: Timer, claimID: string) {
    const now = Date.now()
    const row = yield* queue.claim({ id: trigger.id, claimID, owner, now, until: now + ttl }).pipe(Effect.orDie)
    if (!row) return yield* new RayaTask.GuardError({ message: "This scheduled occurrence already has an owner." })
    return undefined
  })
  const link = Effect.fn("RayaTaskScheduler.link")(function* (trigger: Timer, claimID: string, sessionID: string) {
    if (!(yield* queue.link({ id: trigger.id, claimID, sessionID, now: Date.now() }).pipe(Effect.orDie)))
      return yield* new RayaTask.GuardError({
        message: "Could not link the scheduled occurrence to its session. Recovery is required.",
      })
    return undefined
  })
  const settle = Effect.fn("RayaTaskScheduler.settle")(function* (run: RayaTask.Run) {
    if (run.trigger?.kind !== "timer" || RayaTask.pending(run)) return
    const row = yield* queue.get(run.trigger.id).pipe(Effect.orDie)
    if (!row || row.claim_id !== run.id || row.session_id !== run.sessionID) return
    yield* queue.settle({ id: row.id, claimID: run.id, sessionID: run.sessionID, now: Date.now() }).pipe(Effect.orDie)
  })
  const pulse = Effect.fn("RayaTaskScheduler.pulse")(function* (id: string) {
    const now = Date.now()
    const history = yield* tasks.runsFor(id)
    for (const row of yield* queue.active(id).pipe(Effect.orDie)) {
      if (
        row.owner !== owner ||
        !row.claim_id ||
        row.state !== "linked" ||
        !history.some((run) => run.id === row.claim_id && run.sessionID === row.session_id && RayaTask.pending(run))
      )
        continue
      yield* queue.heartbeat({ id: row.id, claimID: row.claim_id, owner, now, until: now + ttl }).pipe(Effect.orDie)
    }
  })
  const owned = Effect.fn("RayaTaskScheduler.owned")(function* (run: RayaTask.Run) {
    if (run.trigger?.kind !== "timer") return true
    const row = yield* queue.get(run.trigger.id).pipe(Effect.orDie)
    return (
      !row ||
      (row.owner === owner &&
        row.claim_id === run.id &&
        row.session_id === run.sessionID &&
        row.state === "linked" &&
        (row.lease_until ?? 0) > Date.now())
    )
  })
  const active = (id: string) => queue.active(id).pipe(Effect.orDie)
  const status = (row: Row, from: number): "starting" | "active" | "recovery" =>
    row.owner !== owner || (row.lease_until ?? 0) <= from
      ? "recovery"
      : row.state === "starting"
        ? "starting"
        : "active"
  const queued = (id: string, version: number) => queue.pending(id, version).pipe(Effect.orDie)
  return { prepare, check, reserve, link, settle, pulse, owned, active, queued, status, retire, clean }
}
