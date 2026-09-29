import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { RayaTaskQueue } from "./queue"
import { mutate } from "./mutation"
import { removals } from "./removal"
import { Context as ReviewContext, schedulerReview, type Journal, type Snapshot } from "./scheduler-review"

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
  const reviews = schedulerReview(input.storage)
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
    yield* reviews.ensure(owner)
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
    if (
      !row ||
      row.agent_id !== run.agentID ||
      row.schedule_version !== (run.scheduleVersion ?? 1) ||
      row.scheduled_at !== run.trigger.scheduledAt ||
      row.observed_at !== run.trigger.observedAt ||
      (row.timezone ?? undefined) !== run.trigger.tz ||
      row.claim_id !== run.id ||
      row.session_id !== run.sessionID ||
      (row.state !== "linked" && row.state !== "complete")
    )
      return
    const done =
      row.state === "complete" ||
      (yield* queue
        .settle({ id: row.id, claimID: run.id, sessionID: run.sessionID, now: Date.now() })
        .pipe(Effect.orDie))
    if (!done) return
    const current = yield* queue.get(row.id).pipe(Effect.orDie)
    if (!current || current.state !== "complete" || current.claim_id !== run.id || current.session_id !== run.sessionID)
      return
    yield* reviews.finish(run, {
      id: current.id,
      agentID: current.agent_id,
      version: current.schedule_version,
      scheduledAt: current.scheduled_at,
      observedAt: current.observed_at,
      timezone: current.timezone,
    })
  })
  const inspect = Effect.fn("RayaTaskScheduler.inspect")(function* (
    run: RayaTask.Run,
    ctx: typeof ReviewContext.Type,
    immutable: boolean,
  ) {
    yield* Schema.decodeUnknownEffect(ReviewContext)(ctx).pipe(
      Effect.mapError(
        () => new RayaTask.GuardError({ message: "This reviewed follow-up has invalid scheduler context." }),
      ),
    )
    if (run.trigger?.kind !== "timer" || (run.status !== "running" && run.status !== "blocked"))
      return yield* new RayaTask.GuardError({ message: "This run is not an active scheduled follow-up." })
    const item = yield* tasks.get(run.agentID)
    const history = yield* tasks.runsFor(run.agentID)
    const saved = history.find((value) => value.id === run.id)
    const row = yield* queue.get(run.trigger.id).pipe(Effect.orDie)
    const version = item.scheduleVersion ?? 1
    const cursor = yield* queue.cursor(item.id, version).pipe(Effect.orDie)
    if (
      !saved ||
      !isDeepStrictEqual(saved, run) ||
      !item.enabled ||
      (item.schedule.kind !== "once" && item.schedule.kind !== "cron") ||
      version !== run.scheduleVersion ||
      !row ||
      row.id !== run.trigger.id ||
      row.agent_id !== run.agentID ||
      row.schedule_version !== version ||
      row.scheduled_at !== run.trigger.scheduledAt ||
      row.observed_at !== run.trigger.observedAt ||
      (row.timezone ?? undefined) !== run.trigger.tz ||
      row.state !== "linked" ||
      row.claim_id !== run.id ||
      row.session_id !== run.sessionID ||
      cursor?.through !== row.scheduled_at
    )
      return yield* new RayaTask.GuardError({
        message: "This scheduled follow-up changed and needs a fresh recovery review.",
      })
    yield* reviews.available(row.owner ?? "", owner)
    yield* reviews.execution(run, ctx, immutable)
    return { item, row, cursor }
  })
  const review = Effect.fn("RayaTaskScheduler.review")(function* (run: RayaTask.Run, ctx: typeof ReviewContext.Type) {
    yield* inspect(run, ctx, false)
  })
  const snapshot = (row: Row): Snapshot => ({
    owner: row.owner ?? "",
    leaseUntil: row.lease_until,
    updated: row.time_updated,
  })
  const exact = (left: Snapshot, right: Snapshot) => isDeepStrictEqual(left, right)
  const identified = (row: Row, journal: Journal) =>
    row.id === journal.identity.id &&
    row.agent_id === journal.identity.agentID &&
    row.schedule_version === journal.identity.version &&
    row.scheduled_at === journal.identity.scheduledAt &&
    row.observed_at === journal.identity.observedAt &&
    row.timezone === journal.identity.timezone &&
    row.claim_id === journal.identity.runID &&
    row.session_id === journal.identity.sessionID &&
    row.state === "linked"
  const advanced = (row: Snapshot, journal: Journal) =>
    row.owner === journal.target.id &&
    row.leaseUntil !== null &&
    row.leaseUntil >= journal.target.leaseUntil &&
    row.updated >= journal.target.updated
  const phase = (journal: Journal, value: Journal["phase"]): Journal => ({
    ...journal,
    phase: value,
    updatedAt: Date.now(),
  })
  const rearm = Effect.fn("RayaTaskScheduler.rearm")(function* (run: RayaTask.Run, ctx: typeof ReviewContext.Type) {
    return yield* mutate(
      input.storage,
      Effect.gen(function* () {
        const checked = yield* inspect(run, ctx, true)
        const record = yield* reviews.ensure(owner)
        if (!record)
          return yield* new RayaTask.GuardError({
            message: "This backend cannot prove its process identity for reviewed scheduled work.",
          })
        const current = snapshot(checked.row)
        const identity = {
          id: checked.row.id,
          agentID: checked.row.agent_id,
          version: checked.row.schedule_version,
          scheduledAt: checked.row.scheduled_at,
          observedAt: checked.row.observed_at,
          timezone: checked.row.timezone,
          runID: run.id,
          sessionID: run.sessionID,
          cursor: checked.cursor.through,
        }
        const found = yield* reviews.load(run.id)
        const matching =
          found && isDeepStrictEqual(found.identity, identity) && isDeepStrictEqual(found.review, ctx)
            ? found
            : undefined
        const until = Date.now() + ttl
        const journal = matching
          ? matching
          : yield* reviews.prepare({ run, ctx, identity, row: current, owner: record, until })
        const present = yield* queue.get(identity.id).pipe(Effect.orDie)
        if (!present || !identified(present, journal))
          return yield* new RayaTask.GuardError({ message: "This scheduled follow-up occurrence disappeared." })
        const row = snapshot(present)
        const old = journal.target.id !== owner
        if (old && !((journal.phase === "prepared" && exact(row, journal.prior)) || advanced(row, journal)))
          return yield* new RayaTask.GuardError({ message: "This scheduled follow-up changed rearm authority." })
        if (old) yield* reviews.available(journal.target.id, owner, journal.target.owner)
        const renew = advanced(row, journal) && (old || (row.leaseUntil ?? 0) <= Date.now())
        const next =
          old || renew
            ? yield* reviews.replace(journal, {
                ...journal,
                phase: "prepared",
                prior: row,
                target: { id: owner, owner: record.owner, leaseUntil: until, updated: Date.now() },
                updatedAt: Date.now(),
              })
            : journal
        if (advanced(row, next)) {
          if (next.phase === "complete") return
          const cas = next.phase === "cas" ? next : yield* reviews.replace(next, phase(next, "cas"))
          yield* reviews.replace(cas, phase(cas, "complete"))
          return
        }
        if (!exact(row, next.prior) || next.phase !== "prepared")
          return yield* new RayaTask.GuardError({ message: "This scheduled follow-up changed during rearm." })
        const changed = yield* queue
          .rearm({
            id: identity.id,
            agentID: identity.agentID,
            version: identity.version,
            scheduledAt: identity.scheduledAt,
            observedAt: identity.observedAt,
            timezone: identity.timezone,
            claimID: identity.runID,
            sessionID: identity.sessionID,
            owner: next.prior.owner,
            leaseUntil: next.prior.leaseUntil,
            updated: next.prior.updated,
            nextOwner: next.target.id,
            now: next.target.updated,
            until: next.target.leaseUntil,
          })
          .pipe(Effect.orDie)
        if (!changed)
          return yield* new RayaTask.GuardError({ message: "This scheduled follow-up lost its exact rearm claim." })
        const cas = yield* reviews.replace(next, phase(next, "cas"))
        yield* reviews.replace(cas, phase(cas, "complete"))
      }),
      "Scheduled follow-up rearm",
    )
  })
  const resolve = Effect.fn("RayaTaskScheduler.resolve")(function* (input: {
    id: string
    claimID: string
    sessionID?: string
    reason: string
    now: number
    requireExpired: boolean
  }) {
    if (yield* queue.resolve(input).pipe(Effect.orDie)) return
    return yield* new RayaTask.GuardError({
      kind: "conflict",
      message: "This interrupted start changed. Reload its recovery review before closing it.",
    })
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
  return {
    prepare,
    check,
    reserve,
    link,
    settle,
    review,
    rearm,
    resolve,
    pulse,
    owned,
    active,
    queued,
    status,
    retire,
    clean,
  }
}
