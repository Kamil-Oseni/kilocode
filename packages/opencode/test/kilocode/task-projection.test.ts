import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { Git } from "@/git"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProjectV2 } from "@opencode-ai/core/project"

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
      yield* reports.publishDeferred({ agent, id: "occurrence", at: 1, summary: "Waiting" })
      expect((yield* reports.publishDeferred({ agent, id: "occurrence", at: 1, summary: "Waiting" }))?.revision).toBe(1)
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
      return { agent, run }
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const reports = RayaRoutineReports.make({ storage: yield* Storage.Service, sessions, scope: source })
      expect(yield* reports.list(source.id)).toHaveLength(2)
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
    }).pipe(Effect.provide(state(directory)))
  }),
)
