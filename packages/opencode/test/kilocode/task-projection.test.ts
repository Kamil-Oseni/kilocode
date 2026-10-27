import { expect } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { make as reportOrigin } from "@/kilocode/task/report-origin"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { Git } from "@/git"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProjectV2 } from "@opencode-ai/core/project"
import {
  RoutineEffectScope as Scopes,
  RoutineEffectRevocation as Revocations,
} from "@opencode-ai/core/kilocode/routine-effect.sql"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (directory: string) =>
  Storage.layerFromDir(path.join(directory, "storage")).pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(directory, "state.sqlite"))),
  )
const info = (id: string, directory: string): Session.Info => ({
  id: SessionID.make(id),
  slug: id,
  title: id,
  directory,
  projectID: ProjectV2.ID.make("global"),
  version: "1",
  time: { created: 1, updated: 1 },
})

it.live("assignment report origins survive reopening and reject destination changes", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const caller = SessionID.make("ses_requesting_conversation")
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const origins = reportOrigin(storage)
      expect(yield* origins.save("organization-chat:root", caller)).toBe(true)
      expect(yield* origins.save("organization-chat:root", caller)).toBe(true)
      expect(yield* origins.save("organization-chat:root", SessionID.make("ses_other"))).toBe(false)
      expect(yield* origins.save("organization-chat:separate", SessionID.make("ses_separate"))).toBe(true)
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const origins = reportOrigin(storage)
      expect(yield* origins.resolve(["organization-chat:root", "delegate:builder", "delegate:sales"])).toBe(caller)
      expect(yield* origins.resolve(["organization-chat:separate"])).toBe(SessionID.make("ses_separate"))
      expect(yield* origins.resolve(["legacy-assignment"])).toBeUndefined()
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("routine cards survive reopening, upgrade queued occurrences and keep their destination", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const source = info("ses_source", directory)
    const target = info("ses_target", directory)
    const items = new Map([
      [source.id, source],
      [target.id, target],
    ])
    const sessions = {
      get: (id: SessionID) =>
        items.has(id) ? Effect.succeed(items.get(id)!) : Effect.fail(new Storage.NotFoundError({ message: "deleted" })),
    }
    const saved = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      const agent = yield* tasks.create({
        name: "Report",
        objective: "Work",
        schedule: { kind: "manual" },
        sourceSessionID: source.id,
      })
      const reports = RayaRoutineReports.make({ storage, sessions, scope: source })
      yield* reports.publishDeferred({
        agent,
        id: "occurrence",
        at: 1,
        summary: "Waiting",
        notice: { at: 30, reason: "busy" },
      })
      const pending = yield* reports.publishDeferred({ agent, id: "occurrence", at: 0, summary: "Queued" })
      expect(pending?.revision).toBe(1)
      expect(pending?.summary).toBe("Waiting")
      expect(pending?.notice).toEqual({ at: 30, reason: "busy" })
      const run: RayaTask.Run = {
        id: "run",
        agentID: agent.id,
        sessionID: SessionID.make("ses_worker"),
        at: 2,
        status: "running",
        revision: 1,
      }
      yield* reports.publish({ agent: { ...agent, reportSessionID: target.id }, run, occurrenceID: "occurrence" })
      yield* reports.publish({
        agent,
        run: {
          ...run,
          status: "complete",
          revision: 2,
          outcome: { kind: "notify", summary: "Done".repeat(3000), cost: 0 },
        },
        occurrenceID: "occurrence",
      })
      yield* reports.publish({ agent, run, occurrenceID: "occurrence" })
      const cards = yield* reports.list(source.id)
      expect(cards).toHaveLength(1)
      expect(cards[0]).toMatchObject({
        id: "occurrence",
        runID: "run",
        status: "complete",
        revision: 3,
        runRevision: 2,
        reportSessionID: source.id,
        delivery: "delivered",
        notice: { at: 30, reason: "busy" },
      })
      expect(cards[0].summary).toHaveLength(8000)
      expect(yield* reports.list(target.id)).toEqual([])
      const explicit = RayaRoutineReports.make({
        storage,
        scope: source,
        sessions: { get: () => Effect.succeed(source) },
      })
      const selected = yield* explicit.publishDeferred({
        agent: { ...agent, sourceSessionID: undefined, reportSessionID: source.id },
        id: "selected",
        at: 1,
        summary: "Waiting",
      })
      expect(selected?.delivery).toBe("delivered")
      expect(selected?.sourceSessionID).toBeUndefined()
      yield* reports.publishDeferred({ agent, id: "stopped", at: 3, summary: "Queued" })
      const stopped = yield* reports.publishDeferred({
        agent,
        id: "stopped",
        at: 4,
        status: "stopped",
        summary: "Stopped before startup",
      })
      for (const status of ["running", "complete"] as const) {
        const late = yield* reports.publish({
          agent,
          run: { ...run, id: "late-run", status },
          delegationID: "stopped",
        })
        expect(late).toEqual(stopped)
        expect(late?.runID).toBeUndefined()
      }
      const legacy = { ...run, id: "legacy-run" }
      yield* reports.publish({ agent, run: legacy })
      const upgraded = yield* reports.publish({
        agent,
        run: { ...legacy, status: "complete", revision: 2 },
        delegationID: "legacy-delegation",
      })
      expect(upgraded).toMatchObject({ id: "legacy-run", runID: "legacy-run", status: "complete" })
      return { agent, run }
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const reports = RayaRoutineReports.make({ storage: yield* Storage.Service, sessions, scope: source })
      expect(yield* reports.list(source.id)).toHaveLength(4)
      const storage = yield* Storage.Service
      const key = ["raya", "routine-reports", createHash("sha256").update("occurrence").digest("hex")]
      const retained = yield* storage.read(key)
      yield* storage.remove(key)
      expect(yield* reports.page({ sessionID: source.id }).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      yield* storage.replace(key, retained)
      expect(yield* reports.list(source.id)).toHaveLength(4)
      items.delete(source.id)
      const card = yield* reports.publish({
        agent: saved.agent,
        run: { ...saved.run, status: "complete", revision: 3 },
        occurrenceID: "occurrence",
      })
      expect(card?.delivery).toBe("unavailable")
      expect(card?.reportSessionID).toBe(source.id)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("foreign destinations stay undelivered and policy edits advance the schedule version", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      const source = info("ses_source", directory)
      const target = info("ses_foreign", path.join(directory, "foreign"))
      const reports = RayaRoutineReports.make({
        storage,
        scope: target,
        sessions: { get: (id) => Effect.succeed(id === source.id ? source : target) },
      })
      const agent = yield* tasks.create({
        name: "Report",
        objective: "Work",
        schedule: { kind: "manual" },
        sourceSessionID: source.id,
        reportSessionID: target.id,
      })
      const card = yield* reports.publishDeferred({ agent, id: "occurrence", at: 1, summary: "Waiting" })
      expect(card?.delivery).toBe("unavailable")
      expect(yield* reports.list(target.id)).toEqual([])
      const next = yield* tasks.update(agent.id, { overlap: "queue", missed: "latest" })
      expect(next.scheduleVersion).toBe(2)
      expect(next).toMatchObject({ overlap: "queue", missed: "latest", sourceSessionID: source.id })
      expect((yield* tasks.update(agent.id, { overlap: "queue" })).scheduleVersion).toBe(2)
      expect(yield* tasks.update(agent.id, { sourceSessionID: target.id }).pipe(Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
      expect(
        yield* tasks
          .update(agent.id, { reportSessionID: source.id, expectedReportSessionID: "unset" })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      expect(
        yield* reports.publishDeferred({
          agent: { ...agent, sourceSessionID: undefined, reportSessionID: undefined },
          id: "legacy",
          at: 2,
          summary: "Legacy",
        }),
      ).toBeUndefined()
      const database = yield* Database.Service
      // A synthetic negative association tests publication retirement only;
      // it grants no enrolled writer, session execution or external authority.
      yield* database.db
        .insert(Scopes)
        .values({
          id: "a".repeat(64),
          kind: "config",
          principal: `routine-report:${createHash("sha256").update("occurrence").digest("hex")}`,
          birth: "1",
          generation: "b".repeat(32),
          projection: "c".repeat(64),
          state: "active",
        })
        .run()
      for (const [kind, principal, digit] of [
        ["principal", agent.id, "d"],
        ["run", "observed-run", "e"],
        ["session", target.id, "f"],
      ] as const) {
        yield* database.db
          .insert(Scopes)
          .values({
            id: digit.repeat(64),
            kind,
            principal,
            birth: "1",
            generation: digit.repeat(32),
            projection: "c".repeat(64),
            state: "active",
          })
          .run()
      }
      yield* reports.publishDeferred({ agent, id: "occurrence", at: 2, summary: "Still waiting" })
      yield* reports.publish({
        agent,
        occurrenceID: "occurrence",
        run: { id: "observed-run", agentID: agent.id, sessionID: target.id, at: 3, status: "running", revision: 1 },
      })
      const scopes = yield* database.db.select().from(Scopes).all()
      expect(scopes.find((row) => row.kind === "config")?.state).toBe("revoking")
      expect(scopes.filter((row) => row.kind !== "config").map((row) => row.state)).toEqual([
        "active",
        "active",
        "active",
      ])
      expect((yield* database.db.select().from(Revocations).all())[0].state).toBe("published")
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("retired calendar cards reconcile in their frozen conversation once across reopening", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const source = info("ses_calendar_caller", directory)
    const target = info("ses_calendar_target", directory)
    const foreign = info("ses_calendar_foreign", path.join(directory, "foreign"))
    const sessions = {
      get: (id: SessionID) => Effect.succeed(id === source.id ? source : id === target.id ? target : foreign),
    }
    const saved = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage, database })
      const queue = RayaTaskQueue.make(database)
      const reports = RayaRoutineReports.make({ storage, database, sessions, scope: source })
      const at = Date.now() + 60_000
      const agent = yield* tasks.create({
        name: "Calendar reports",
        objective: "Review notes",
        schedule: { kind: "once", at },
        sourceSessionID: source.id,
        reportSessionID: target.id,
      })
      yield* queue.publish({
        agentID: agent.id,
        version: 1,
        occurrences: [0, 1, 2, 3].map((offset) => ({ at: at + offset, observedAt: at + offset })),
      })
      const rows = yield* queue.pending(agent.id, 1)
      const cards = yield* Effect.forEach(rows, (row) =>
        reports.publishDeferred({
          agent: row === rows[2] ? { ...agent, sourceSessionID: foreign.id } : agent,
          id: row.id,
          at: row.observed_at,
          summary: "Waiting",
          notice: { at: row.observed_at + 31 * 60_000, reason: "busy" },
        }),
      )
      const manual = yield* reports.publishDeferred({ agent, id: "rdl_manual_retained", at, summary: "Manual waiting" })
      const active = rows[1]
      yield* queue.claim({ id: active.id, claimID: "live", owner: "backend", now: at, until: at + 180_000 })
      const other = yield* tasks.create({ name: "Other", objective: "Work", schedule: { kind: "manual" } })
      const mismatch = cards[3]!
      yield* storage.replace(["raya", "routine-reports", createHash("sha256").update(mismatch.id).digest("hex")], {
        ...mismatch,
        agentID: other.id,
      })
      yield* queue.retire(agent.id, 2)
      // Repair must not rely on a live roster definition or its current report destination.
      yield* tasks.update(agent.id, { reportSessionID: source.id, expectedReportSessionID: target.id })
      const changed: string[] = []
      const listener = (event: GlobalEvent) => {
        if (event.payload.type === "raya.routine.report.changed") changed.push(event.payload.properties.card.id)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
      const page = yield* reports.page({ sessionID: target.id, limit: 200 })
      const repaired = page.items.find((card) => card.id === rows[0].id)
      expect(repaired).toEqual({
        ...cards[0],
        status: "stopped",
        summary: "Replaced by a newer schedule version.",
        revision: 2,
      })
      expect(page.items.find((card) => card.id === active.id)).toEqual(cards[1])
      expect(page.items.some((card) => card.id === rows[2].id)).toBe(false)
      expect(changed).toEqual([rows[0].id])
      expect(yield* reports.list(source.id)).toEqual([])
      const all = yield* reports.list(target.id)
      expect(all.find((card) => card.id === manual?.id)).toEqual(manual)
      expect(all.find((card) => card.id === mismatch.id)).toEqual({ ...mismatch, agentID: other.id })
      expect(changed).toEqual([rows[0].id])
      const retained = yield* storage.read([
        "raya",
        "routine-reports",
        createHash("sha256").update(rows[2].id).digest("hex"),
      ])
      expect(retained).toEqual(cards[2])
      return { repaired, active: cards[1], manual, target }
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const reports = RayaRoutineReports.make({ storage, database, sessions, scope: source })
      const cards = yield* reports.list(saved.target.id)
      expect(cards.find((card) => card.id === saved.repaired?.id)).toEqual(saved.repaired)
      expect(cards.find((card) => card.id === saved.active?.id)).toEqual(saved.active)
      expect(cards.find((card) => card.id === saved.manual?.id)).toEqual(saved.manual)
    }).pipe(Effect.provide(state(directory)))
  }),
)
