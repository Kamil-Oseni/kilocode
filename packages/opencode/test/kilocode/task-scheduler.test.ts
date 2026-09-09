import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import type { Bus } from "@/bus"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { claim } from "@/kilocode/task/claim"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { scheduler } from "@/kilocode/task/scheduler"
import { removals } from "@/kilocode/task/removal"
import { archive as indexed } from "@/kilocode/task/archive"
import { continuation } from "@/kilocode/task/continuation"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { RayaRoutineOccurrenceTable } from "@opencode-ai/core/kilocode/routine.sql"
import { eq, sql } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { owner, stopped } from "@/kilocode/task/owner"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (directory: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(directory, "storage")),
    Database.layerFromPath(path.join(directory, "queue.sqlite")),
  )
const sessions = {
  create: () => Effect.die("unexpected session creation"),
  get: () => Effect.die("unexpected session read"),
  messages: () => Effect.succeed([]),
  children: () => Effect.succeed([]),
}

it.live("the block circuit breaker requires consecutive terminal failures and survives reopening", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const cases = [
      { statuses: ["waiting", "waiting", "waiting"], paused: false },
      { statuses: ["blocked", "complete", "blocked", "blocked"], paused: false },
      { statuses: ["blocked", "error", "blocked", "blocked"], paused: false },
      { statuses: ["blocked", "different", "blocked", "blocked"], paused: false },
      { statuses: ["blocked", "waiting", "blocked", "blocked"], paused: false },
      { statuses: ["blocked", "blocked", "blocked"], paused: true },
    ] as const
    for (const scenario of cases) {
      const id = yield* Effect.gen(function* () {
        const tasks = RayaTask.make({ storage: yield* Storage.Service })
        const agent = yield* tasks.create({ name: "Circuit", objective: "Work", schedule: { kind: "manual" } })
        for (const [index, status] of scenario.statuses.entries()) {
          yield* tasks.record({
            id: `run-${index}`,
            agentID: agent.id,
            at: index,
            sessionID: SessionID.make(`ses_circuit${index}`),
            status: status === "waiting" || status === "different" ? "blocked" : status,
            blockedReason: status === "waiting" ? "waiting on you" : status === "different" ? "Other" : "Needs access",
          })
        }
        return agent.id
      }).pipe(Effect.provide(state(directory)))
      yield* Effect.gen(function* () {
        const tasks = RayaTask.make({ storage: yield* Storage.Service })
        const agent = yield* tasks.get(id)
        expect(agent.enabled).toBe(!scenario.paused)
        expect((yield* tasks.runsFor(id)).length).toBe(scenario.statuses.length)
        if (scenario.paused) expect(agent.note).toContain("3 consecutive blocks")
      }).pipe(Effect.provide(state(directory)))
    }
  }),
)

it.live("the block circuit breaker respects logical run order, identities and schedule versions", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const tasks = RayaTask.make({ storage: yield* Storage.Service })
      const agent = yield* tasks.create({ name: "Circuit", objective: "Work", schedule: { kind: "manual" } })
      const record = (at: number, status: "blocked" | "complete", version = 1) =>
        tasks.record({
          id: `run-${at}`,
          agentID: agent.id,
          at,
          sessionID: SessionID.make(`ses_circuit${at}`),
          status,
          scheduleVersion: version,
          blockedReason: status === "blocked" ? "Needs access" : undefined,
        })
      yield* record(1, "blocked")
      yield* record(3, "complete")
      yield* record(4, "blocked")
      // An older block arriving late cannot erase the intervening successful run.
      yield* record(2, "blocked")
      expect((yield* tasks.get(agent.id)).enabled).toBe(true)
      yield* tasks.update(agent.id, { schedule: { kind: "event", source: "test" } })
      yield* record(5, "blocked", 2)
      yield* record(6, "blocked", 2)
      yield* record(6, "blocked", 2)
      expect((yield* tasks.get(agent.id)).enabled).toBe(true)
      // Late settlement from an old schedule must not disable its replacement.
      yield* record(7, "blocked", 1)
      yield* record(8, "blocked", 1)
      expect((yield* tasks.get(agent.id)).enabled).toBe(true)
      yield* record(9, "blocked", 2)
      expect((yield* tasks.get(agent.id)).enabled).toBe(false)
      expect((yield* tasks.runsFor(agent.id)).filter((run) => run.id === "run-6")).toHaveLength(1)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("a failed circuit pause blocks new launches and reconciles without undoing an explicit resume", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const id = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage, database })
      const agent = yield* tasks.create({
        name: "Circuit",
        objective: "Work",
        schedule: { kind: "event", source: "circuit" },
      })
      for (const at of [1, 2])
        yield* tasks.record({
          id: `run-${at}`,
          agentID: agent.id,
          at,
          sessionID: SessionID.make(`ses_pause${at}`),
          status: "blocked",
          blockedReason: "Needs access",
        })
      const runner = RayaTaskRunner.make({
        database,
        sessions,
        storage: {
          ...storage,
          replace: (key, value) =>
            key.join("/") === "raya/agent" ? Effect.die("Roster unavailable") : storage.replace(key, value),
        },
      })
      expect(
        Exit.isFailure(
          yield* runner.tasks
            .record({
              id: "run-3",
              agentID: agent.id,
              at: 3,
              sessionID: SessionID.make("ses_pause3"),
              status: "blocked",
              blockedReason: "Needs access",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* tasks.runsFor(agent.id)).toHaveLength(3)
      expect((yield* tasks.get(agent.id)).enabled).toBe(true)
      expect(Exit.isFailure(yield* runner.fire(agent.id).pipe(Effect.exit))).toBe(true)
      expect((yield* runner.preview(Date.now())).find((item) => item.id === agent.id)).toMatchObject({
        enabled: false,
        nextRun: undefined,
        note: "Paused after 3 consecutive blocks for the same reason: Needs access",
      })
      expect((yield* tasks.get(agent.id)).enabled).toBe(true)
      expect(yield* tasks.eligible({ ...agent, schedule: { kind: "once", at: 1 } }, Date.now())).toBe(false)
      expect(yield* tasks.listenFor("circuit")).toEqual([])
      expect(yield* tasks.launchable(agent.id).pipe(Effect.flip)).toMatchObject({
        _tag: "RayaTask.GuardError",
        message: "Paused after 3 consecutive blocks for the same reason: Needs access",
      })
      expect(yield* storage.list(["raya", "agent-claims"])).toEqual([])
      return agent.id
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const runner = RayaTaskRunner.make({ storage, database, sessions })
      yield* runner.tick(Date.now())
      expect((yield* runner.tasks.get(id)).enabled).toBe(false)
      expect(yield* runner.fire(id).pipe(Effect.flip)).toMatchObject({ _tag: "RayaTask.GuardError" })
      const broken = RayaTask.make({
        storage: {
          ...storage,
          replace: () => Effect.die("Roster unavailable"),
        },
      })
      expect(Exit.isFailure(yield* broken.update(id, { enabled: true }).pipe(Effect.exit))).toBe(true)
      expect((yield* runner.tasks.get(id)).blockReset).toBeUndefined()
      expect((yield* runner.tasks.get(id)).enabled).toBe(false)
      yield* runner.tasks.update(id, { enabled: true })
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const tasks = RayaTask.make({ storage: yield* Storage.Service })
      yield* tasks.enforce(id)
      expect((yield* tasks.get(id)).enabled).toBe(true)
      expect((yield* tasks.get(id)).note).toBeUndefined()
      expect((yield* tasks.preview(Date.now())).find((item) => item.id === id)?.enabled).toBe(true)
      expect((yield* tasks.listenFor("circuit")).map((item) => item.id)).toEqual([id])
      expect((yield* tasks.get(id)).blockReset).toEqual(["run-1", "run-2", "run-3"])
      for (const at of [4, 5, 6]) {
        yield* tasks.record({
          id: `run-${at}`,
          agentID: id,
          at,
          sessionID: SessionID.make(`ses_pause${at}`),
          status: "blocked",
          blockedReason: "Needs access",
        })
        expect((yield* tasks.get(id)).enabled).toBe(at < 6)
      }
      expect(yield* tasks.runsFor(id)).toHaveLength(6)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("routine startup persists authoritative goal criteria before dispatch", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const input = { storage, database: yield* Database.Service }
      const sid = SessionID.make("ses_routine_criteria")
      const session = {
        id: sid,
        slug: "criteria",
        title: "Routine",
        projectID: ProjectV2.ID.make("project"),
        directory,
        version: "test",
        time: { created: Date.now(), updated: Date.now() },
      }
      const runner = RayaTaskRunner.make({
        ...input,
        sessions: { ...sessions, create: () => Effect.succeed(session) },
        storage: {
          ...storage,
          replace: (key, value) =>
            storage
              .replace(key, value)
              .pipe(Effect.andThen(key[1] === "goal" ? Effect.die("Stop before dispatch") : Effect.void)),
        },
      })
      const output: RayaTask.Output = {
        destination: "conversation",
        description: "Report",
        criteria: [{ id: "sources", description: "List sources", verification: "Check references" }],
      }
      const agent = yield* runner.tasks.create({
        name: "Report",
        objective: "Review sources",
        output,
        schedule: { kind: "manual" },
      })
      expect(Exit.isFailure(yield* runner.fire(agent.id).pipe(Effect.exit))).toBe(true)
      const goals = RayaGoal.make({ ...input, sessions })
      const saved = yield* goals.get(sid)
      expect(saved?.criteria).toEqual(output.criteria)
      expect(saved?.objective).toContain("criterionID")
      yield* runner.tasks.update(agent.id, {
        output: { ...output, criteria: [{ ...output.criteria[0], description: "Future requirement" }] },
      })
      expect((yield* goals.get(sid))?.criteria).toEqual(output.criteria)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("startup pins its resolved instructions before session creation and refuses snapshot replacement", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const pinned = yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const snapshots = RayaTaskSnapshot.make(input)
      const observed: Array<typeof RayaTaskSnapshot.Info.Type> = []
      const runner = RayaTaskRunner.make({
        ...input,
        sessions: {
          ...sessions,
          create: (params) =>
            Effect.gen(function* () {
              for (const permission of [
                "edit",
                "write",
                "bash",
                "apply_patch",
                "task",
                "browser_click",
                "mcp_send_message",
              ])
                expect(Permission.evaluate(permission, "file", params?.permission ?? []).action).toBe("deny")
              const keys = yield* input.storage.list(["raya", "agent-starts"])
              expect(keys).toHaveLength(1)
              const saved = yield* input.storage.read(keys[0])
              observed.push(yield* Schema.decodeUnknownEffect(RayaTaskSnapshot.Info)(saved).pipe(Effect.orDie))
              return yield* Effect.die("session response lost")
            }).pipe(Effect.orDie),
        },
      })
      const output: RayaTask.Output = {
        destination: "conversation",
        description: "A report of changed project documents",
        criteria: [
          {
            id: "sources",
            description: "Identify each reviewed document",
            verification: "Link each source path and identify unreadable documents",
          },
        ],
      }
      const invalid = yield* runner.tasks
        .create({
          name: "Invalid contract",
          objective: "Work",
          schedule: { kind: "manual" },
          output: { ...output, criteria: [output.criteria[0], output.criteria[0]] },
        })
        .pipe(Effect.flip)
      expect(invalid.message).toContain("unique")
      expect(yield* runner.tasks.list()).toEqual([])
      const agent = yield* runner.tasks.create({
        name: "Pinned",
        output,
        objective: "Original instructions",
        schedule: { kind: "manual" },
        memoryScope: "role",
      })
      yield* runner.tasks.remember(agent.id, "Original context")
      expect(Exit.isFailure(yield* runner.fire(agent.id).pipe(Effect.exit))).toBe(true)
      const snapshot = observed[0]
      if (!snapshot) throw new Error("Expected snapshot before session creation")
      expect((yield* runner.preview(Date.now()))[0]?.execution).toEqual({ state: "recovery", runID: snapshot.runID })
      expect(yield* runner.tasks.runsFor(agent.id)).toEqual([])
      expect(snapshot.definition.objective).toBe("Original instructions")
      expect(snapshot.objective).toContain("Original context")
      expect(snapshot.definition.output).toEqual(output)
      expect(snapshot.objective).toContain("Required output (deliver in this run's conversation)")
      expect(snapshot.objective).toContain("[sources] Identify each reviewed document")
      expect(snapshot.objective).toContain(output.criteria[0].verification)
      const rejected = yield* runner.tasks.update(agent.id, { output: { ...output, criteria: [] } }).pipe(Effect.flip)
      expect(rejected.message).toContain("criteria")
      expect((yield* runner.tasks.get(agent.id)).output).toEqual(output)
      yield* runner.tasks.update(agent.id, {
        objective: "Edited instructions",
        output: { ...output, description: "Edited deliverable" },
      })
      expect((yield* runner.tasks.get(agent.id)).output?.description).toBe("Edited deliverable")
      yield* runner.tasks.remember(agent.id, "Edited context")
      expect(yield* snapshots.get(snapshot.runID)).toEqual(snapshot)
      expect(yield* snapshots.save(snapshot)).toEqual(snapshot)
      expect(Exit.isFailure(yield* snapshots.save({ ...snapshot, objective: "Replacement" }).pipe(Effect.exit))).toBe(
        true,
      )
      expect(yield* snapshots.get(snapshot.runID)).toEqual(snapshot)
      const clean = yield* snapshots.save({
        ...snapshot,
        runID: "projection",
        definition: { ...snapshot.definition, nextRun: 123, execution: { state: "recovery" } },
      })
      expect(clean.definition.nextRun).toBeUndefined()
      expect(clean.definition.execution).toBeUndefined()
      expect(yield* snapshots.save(clean)).toEqual(clean)
      const attempts: string[] = []
      const failure = RayaTaskRunner.make({
        ...input,
        sessions: {
          ...sessions,
          create: () =>
            Effect.sync(() => attempts.push("created")).pipe(Effect.andThen(Effect.die("unexpected creation"))),
        },
        storage: {
          ...input.storage,
          create: (key, value) =>
            key[1] === "agent-starts" ? Effect.die("snapshot unavailable") : input.storage.create(key, value),
        },
      })
      const second = yield* failure.tasks.create({
        name: "Failure",
        objective: "Do not start",
        schedule: { kind: "manual" },
      })
      expect(Exit.isFailure(yield* failure.fire(second.id).pipe(Effect.exit))).toBe(true)
      expect(yield* failure.tasks.runsFor(second.id)).toEqual([])
      expect(attempts).toEqual([])
      return snapshot
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const snapshots = RayaTaskSnapshot.make({ storage })
      expect(yield* snapshots.get(pinned.runID)).toEqual(pinned)
      const key = ["raya", "agent-starts", createHash("sha256").update(pinned.runID).digest("hex")]
      yield* storage.replace(key, { ...pinned, runID: "mismatched" })
      expect(Exit.isFailure(yield* snapshots.get(pinned.runID).pipe(Effect.exit))).toBe(true)
      const cancelled = yield* RayaTaskSnapshot.make({ storage: { ...storage, read: () => Effect.interrupt } })
        .find(pinned.runID)
        .pipe(Effect.exit)
      expect(Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause)).toBe(true)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(directory, "storage"))))
  }),
)

it.live("event startup failure exposes saved instructions without queue or history", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const runner = RayaTaskRunner.make({ storage, sessions })
      const agent = yield* runner.tasks.create({
        name: "Event",
        objective: "Inspect CI",
        schedule: { kind: "event", source: "ci" },
      })
      expect(Exit.isFailure(yield* runner.announce("ci").pipe(Effect.exit))).toBe(true)
      expect(yield* runner.tasks.runsFor(agent.id)).toEqual([])
      const execution = (yield* runner.preview(Date.now()))[0]?.execution
      expect(execution?.state).toBe("recovery")
      if (!execution?.runID) throw new Error("Expected retained event identity")
      expect((yield* RayaTaskSnapshot.make({ storage }).get(execution.runID)).definition.schedule).toEqual({
        kind: "event",
        source: "ci",
      })
    }).pipe(Effect.provide(state(directory)))
  }),
)

for (const stage of ["linked", "starting", "unknown"] as const) {
  it.live(
    `recovery restores ${stage} startup history once and retains evidence across publication failures`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
          encoding: "utf8",
          windowsHide: true,
        })
        expect(child.status).toBe(0)
        const dead = { ...owner(), pid: Number(child.stdout) }
        expect(stopped(dead)).toBe(true)
        yield* Effect.gen(function* () {
          const input = { storage: yield* Storage.Service, database: yield* Database.Service }
          const tasks = RayaTask.make(input)
          const queue = RayaTaskQueue.make(input.database)
          const at = Date.now()
          const agent = yield* tasks.create({
            name: "Interrupted",
            objective: "Original work",
            schedule: { kind: "once", at },
          })
          const trigger = yield* scheduler(input).prepare(agent.id, at)
          if (!trigger) throw new Error("Expected queued work")
          const sid = SessionID.make("ses_interrupted_history")
          yield* queue.claim({
            id: trigger.id,
            claimID: "interrupted",
            owner: "stopped-backend",
            now: at,
            until: at + 180_000,
          })
          if (stage === "linked") yield* queue.link({ id: trigger.id, claimID: "interrupted", sessionID: sid, now: at })
          const key = ["raya", "agent-claims", createHash("sha256").update(agent.id).digest("hex")]
          const claim = {
            version: 1,
            agentID: agent.id,
            id: "interrupted",
            at,
            phase: stage === "unknown" ? "claimed" : "session-created",
            owner: owner(),
            ...(stage === "unknown" ? {} : { sessionID: sid }),
            trigger,
          }
          yield* input.storage.replace(key, claim)
          const session = {
            id: sid,
            slug: "routine",
            projectID: ProjectV2.ID.make("project"),
            directory: "/repo",
            title: "Interrupted",
            version: "test",
            time: { created: at, updated: at },
            metadata: { rayaRoutine: { version: 2, agentID: agent.id, runID: claim.id, scheduleVersion: 1, trigger } },
          }
          const client = { ...sessions, get: () => Effect.succeed(session) }
          const goals = RayaGoal.make({ ...input, sessions: client })
          if (stage === "linked") yield* goals.create(sid, "Original work")
          const runner = RayaTaskRunner.make({ ...input, sessions: client })
          yield* runner.revive()
          expect(yield* tasks.runsFor(agent.id)).toEqual([])
          yield* input.storage.replace(key, { ...claim, owner: dead })
          if (stage === "unknown") {
            yield* runner.revive()
            expect(yield* tasks.runsFor(agent.id)).toEqual([])
            yield* input.database.db.run(
              sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${session.projectID}, ${directory}, ${JSON.stringify([])}, ${at}, ${at})`,
            )
            for (const id of [sid, SessionID.make("ses_duplicate_start")]) {
              yield* input.database.db.run(
                sql`INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated) VALUES (${id}, ${session.projectID}, 'routine', ${directory}, 'Interrupted', 'test', ${JSON.stringify(session.metadata)}, ${at}, ${at})`,
              )
            }
            yield* runner.revive()
            expect(yield* tasks.runsFor(agent.id)).toEqual([])
            expect((yield* queue.get(trigger.id))?.session_id).toBeNull()
            yield* input.database.db
              .delete(SessionTable)
              .where(eq(SessionTable.id, SessionID.make("ses_duplicate_start")))
              .run()
            yield* input.database.db.run(
              sql`INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated) VALUES ('ses_malformed_neighbor', ${session.projectID}, 'routine', ${directory}, 'Malformed', 'test', '{broken', ${at}, ${at})`,
            )
          }
          yield* input.storage.replace(key, { ...claim, owner: dead, trigger: { ...trigger, scheduledAt: at - 1 } })
          yield* runner.revive()
          expect(yield* tasks.runsFor(agent.id)).toEqual([])
          yield* input.storage.replace(key, { ...claim, owner: dead })
          const wrong = RayaTaskRunner.make({
            ...input,
            sessions: {
              ...client,
              get: () =>
                Effect.succeed({
                  ...session,
                  metadata: { rayaRoutine: { ...session.metadata.rayaRoutine, runID: "wrong" } },
                }),
            },
          })
          yield* wrong.revive()
          expect(yield* tasks.runsFor(agent.id)).toEqual([])
          if (stage !== "linked") {
            yield* input.database.db.run(
              "CREATE TRIGGER fail_routine_link BEFORE UPDATE ON raya_routine_occurrence BEGIN SELECT RAISE(ABORT, 'link publication failed'); END",
            )
            expect(Exit.isFailure(yield* runner.revive().pipe(Effect.exit))).toBe(true)
            expect((yield* queue.get(trigger.id))?.state).toBe("starting")
            expect(yield* tasks.runsFor(agent.id)).toEqual([])
            expect(yield* input.storage.read(key)).toMatchObject({ id: claim.id })
            yield* input.database.db.run("DROP TRIGGER fail_routine_link")
          }
          const failure = RayaTaskRunner.make({
            ...input,
            sessions: client,
            storage: {
              ...input.storage,
              replace: (key, value) =>
                key[1] === "agent-runs" ? Effect.die("history write failed") : input.storage.replace(key, value),
            },
          })
          expect(Exit.isFailure(yield* failure.revive().pipe(Effect.exit))).toBe(true)
          expect(yield* tasks.runsFor(agent.id)).toEqual([])
          expect(yield* input.storage.read(key)).toMatchObject({ id: claim.id })
          const interrupted = RayaTaskRunner.make({
            ...input,
            sessions: client,
            storage: {
              ...input.storage,
              remove: (key) =>
                key[1] === "agent-claims" ? Effect.die("claim cleanup failed") : input.storage.remove(key),
            },
          })
          expect(Exit.isFailure(yield* interrupted.revive().pipe(Effect.exit))).toBe(true)
          const history = yield* tasks.runsFor(agent.id)
          expect(history).toHaveLength(1)
          expect(history[0]).toMatchObject({
            id: claim.id,
            at,
            sessionID: sid,
            trigger,
            scheduleVersion: 1,
            status: stage === "linked" ? "running" : "error",
          })
          expect(yield* input.storage.read(key)).toMatchObject({ id: claim.id })
          const current = history[0]
          if (!current) throw new Error("Expected recovered history")
          if (stage === "linked")
            yield* tasks.transition(current, { ...current, status: "blocked", blockedReason: "waiting on you" })
          if (stage !== "linked") expect(current.blockedReason).toContain("No saved goal is available")
          const waiting = yield* tasks.runsFor(agent.id)
          yield* Effect.all([runner.revive(), runner.revive()], { concurrency: 2 })
          expect(yield* tasks.runsFor(agent.id)).toEqual(waiting)
          expect((yield* input.storage.read(key).pipe(Effect.flip))._tag).toBe("NotFoundError")
          expect(
            yield* input.storage.read([
              "raya",
              "agent-recovery",
              key[2],
              createHash("sha256").update(claim.id).digest("hex"),
            ]),
          ).toMatchObject({
            settled: true,
            claim: { ...claim, owner: dead },
          })
          expect((yield* queue.get(trigger.id))?.owner).toBe("stopped-backend")
          expect((yield* goals.get(sid))?.usage.continuations).toBe(stage === "linked" ? 0 : undefined)
          expect((yield* queue.get(trigger.id))?.session_id).toBe(sid)
          expect((yield* queue.get(trigger.id))?.state).toBe("linked")
          expect((yield* runner.preview(Date.now()))[0]?.execution).toEqual({
            state: "recovery",
            sessionID: sid,
            runID: claim.id,
          })
          expect((yield* runner.fire(agent.id).pipe(Effect.flip))._tag).toBe("RayaTask.GuardError")
        }).pipe(Effect.provide(state(directory)))
      }),
    30_000,
  )
}

it.live("goal expiry preserves routine references and defers cleanup when their evidence is uncertain", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const runner = RayaTaskRunner.make({ storage, database, sessions })
      const goals = RayaGoal.make({ storage, sessions })
      const agent = yield* runner.tasks.create({ name: "Delayed", objective: "Report", schedule: { kind: "manual" } })
      const sid = SessionID.make("ses_delayed_goal")
      const old = Date.now() - 31 * 24 * 60 * 60 * 1000
      const goal = {
        objective: "Report",
        status: "complete",
        createdAt: old,
        updatedAt: old,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        audit: { summary: "Verified report", verifiedAt: old, requirements: [] },
      }
      yield* runner.tasks.record({ id: "delayed", agentID: agent.id, sessionID: sid, at: old, status: "running" })
      yield* storage.replace(["raya", "goal", sid], goal)
      expect((yield* goals.get(sid))?.status).toBe("complete")
      yield* runner.settle(sid)
      expect((yield* runner.tasks.runsFor(agent.id))[0]).toMatchObject({
        status: "complete",
        outcome: { summary: "Verified report" },
      })
      expect((yield* goals.get(sid))?.audit?.summary).toBe("Verified report")
      yield* storage.remove(["raya", "agent-runs", agent.id])
      yield* storage.replace(["raya", "agent-claims", "retained"], {
        version: 1,
        id: "delayed",
        agentID: agent.id,
        sessionID: sid,
      })
      expect((yield* goals.get(sid))?.status).toBe("complete")
      yield* storage.replace(["raya", "agent-claims", "retained"], {
        version: 1,
        id: "uncertain",
        agentID: agent.id,
      })
      expect((yield* goals.get(sid))?.status).toBe("complete")
      yield* storage.remove(["raya", "agent-claims", "retained"])
      yield* storage.replace(["raya", "agent-runs", agent.id], [{ broken: true }])
      expect((yield* goals.get(sid))?.status).toBe("complete")
      expect(yield* storage.read(["raya", "agent-runs", agent.id])).toEqual([{ broken: true }])
      yield* storage.remove(["raya", "agent-runs", agent.id])
      const interrupted = RayaGoal.make({
        storage: {
          ...storage,
          list: (key) => (key.join("/") === "raya/agent-runs" ? Effect.interrupt : storage.list(key)),
        },
        sessions,
      })
      const exit = yield* interrupted.get(sid).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* storage.read(["raya", "goal", sid])).toEqual(goal)
      expect(yield* goals.get(sid)).toBeUndefined()
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live(
  "settlement does not turn an objective into an outcome or learned role memory",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const runner = RayaTaskRunner.make({ ...input, sessions })
        for (const [index, summary] of [undefined, "", "  ", "  Verified result  "].entries()) {
          const agent = yield* runner.tasks.create({
            name: `Result ${index}`,
            objective: "Requested work is not evidence",
            schedule: { kind: "manual" },
          })
          const sid = SessionID.make(`ses_result_${index}`)
          const at = Date.now()
          yield* input.storage.replace(["raya", "goal", sid], {
            objective: agent.objective,
            status: "complete",
            createdAt: at,
            updatedAt: at,
            usage: { turns: 1, continuations: 0, toolCalls: 1 },
            progress: [],
            ...(summary === undefined
              ? {}
              : {
                  audit: {
                    summary,
                    verifiedAt: at,
                    requirements: [
                      {
                        requirement: "Check",
                        passed: true,
                        evidence: [{ callID: "call_check", summary: "Recorded check" }],
                      },
                    ],
                  },
                }),
          })
          yield* runner.tasks.record({ id: `run-${index}`, agentID: agent.id, sessionID: sid, at, status: "running" })
          yield* runner.settle(sid)
          const history = yield* runner.tasks.runsFor(agent.id)
          expect(history[0]?.status).toBe("complete")
          expect(history[0]?.outcome?.summary).toBe(summary?.trim() ?? "")
          expect(yield* runner.tasks.recall(agent.id)).toBe(summary?.trim() ?? "")
          if (summary !== undefined) expect(history[0]?.outcome?.evidence).toEqual(["Recorded check"])
          yield* runner.settle(sid)
          expect(yield* runner.tasks.runsFor(agent.id)).toEqual(history)
        }
        const agent = yield* runner.tasks.create({
          name: "Missing goal",
          objective: "Do not report this as a result",
          schedule: { kind: "manual" },
        })
        const sid = SessionID.make("ses_missing_result")
        yield* runner.tasks.record({
          id: "missing-result",
          agentID: agent.id,
          sessionID: sid,
          at: Date.now(),
          status: "running",
        })
        yield* runner.settle(sid)
        const history = yield* runner.tasks.runsFor(agent.id)
        expect(history[0]).toMatchObject({
          status: "error",
          blockedReason:
            "No saved goal is available to verify this run's result. Review its conversation and saved instructions before starting more work.",
          outcome: { summary: "" },
        })
        expect(yield* runner.tasks.recall(agent.id)).toBe("")
        yield* runner.settle(sid)
        expect(yield* runner.tasks.runsFor(agent.id)).toEqual(history)
        const damaged = yield* runner.tasks.create({
          name: "Unreadable goal",
          objective: "Keep unresolved evidence",
          schedule: { kind: "manual" },
        })
        const session = SessionID.make("ses_unreadable_result")
        yield* runner.tasks.record({
          id: "unreadable-result",
          agentID: damaged.id,
          sessionID: session,
          at: Date.now(),
          status: "running",
        })
        const pending = yield* runner.tasks.runsFor(damaged.id)
        const invalid = { status: "not-a-goal", objective: damaged.objective }
        yield* input.storage.replace(["raya", "goal", session], invalid)
        expect(Exit.isFailure(yield* runner.settle(session).pipe(Effect.exit))).toBe(true)
        expect(yield* runner.tasks.runsFor(damaged.id)).toEqual(pending)
        expect(yield* input.storage.read(["raya", "goal", session])).toEqual(invalid)
        expect(yield* runner.tasks.recall(damaged.id)).toBe("")
      }).pipe(Effect.provide(state(directory)))
    }),
  30_000,
)

it.live(
  "settlement uses the startup definition and rejects conflicting snapshot evidence",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const runner = RayaTaskRunner.make({ ...input, sessions })
        for (const scope of ["role", "session"] as const) {
          const agent = yield* runner.tasks.create({
            name: scope,
            role: "briefer",
            objective: "Send a summary",
            memoryScope: scope,
            schedule: { kind: "manual" },
          })
          const sid = SessionID.make(`ses_pinned_${scope}`)
          const at = Date.now()
          const id = `pinned-${scope}`
          const snapshot = {
            version: 1 as const,
            runID: id,
            agentID: agent.id,
            at,
            definition: agent,
            objective: agent.objective,
          }
          yield* RayaTaskSnapshot.make(input).save(snapshot)
          yield* runner.tasks.record({
            id,
            agentID: agent.id,
            sessionID: sid,
            at,
            scheduleVersion: 1,
            status: "running",
          })
          yield* input.storage.replace(["raya", "goal", sid], {
            objective: agent.objective,
            status: "complete",
            createdAt: at,
            updatedAt: at,
            usage: { turns: 1, continuations: 0, toolCalls: 1 },
            progress: [],
            audit: { summary: "Delivered report", verifiedAt: at, requirements: [] },
          })
          yield* runner.tasks.update(agent.id, {
            role: "coder",
            objective: "Build a feature",
            memoryScope: scope === "role" ? "session" : "role",
            schedule: { kind: "once", at: at + 60_000 },
          })
          const key = ["raya", "agent-starts", createHash("sha256").update(id).digest("hex")]
          yield* input.storage.replace(key, { ...snapshot, at: at + 1 })
          expect(Exit.isFailure(yield* runner.settle(sid).pipe(Effect.exit))).toBe(true)
          expect((yield* runner.tasks.runsFor(agent.id))[0]?.status).toBe("running")
          expect(yield* runner.tasks.recall(agent.id)).toBe("")
          yield* input.storage.replace(key, snapshot)
          yield* runner.settle(sid)
          expect((yield* runner.tasks.runsFor(agent.id))[0]).toMatchObject({
            status: "complete",
            scheduleVersion: 1,
            outcome: { kind: "notify", summary: "Delivered report" },
          })
          expect(yield* runner.tasks.recall(agent.id)).toBe(scope === "role" ? "Delivered report" : "")
          expect((yield* runner.tasks.get(agent.id)).role).toBe("coder")
        }
      }).pipe(Effect.provide(state(directory)))
    }),
  30_000,
)

for (const trigger of [{ kind: "manual" as const }, { kind: "event" as const, source: "ci", receivedAt: 1234 }]) {
  it.live(`${trigger.kind} continuation rejects retained claims and permits only linked local startup history`, () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const tasks = RayaTask.make(input)
        const agent = yield* tasks.create({ name: "Guarded", objective: "Work", schedule: { kind: "manual" } })
        const sid = SessionID.make("ses_manual_continuation")
        const at = Date.now()
        const identity = { version: 1, agentID: agent.id, runID: "", scheduleVersion: 1, trigger }
        const session = {
          id: sid,
          slug: "routine",
          projectID: ProjectV2.ID.make("project"),
          directory: "/repo",
          title: "Routine",
          version: "test",
          time: { created: at, updated: at },
          metadata: { rayaRoutine: identity },
        }
        const client = { ...sessions, get: () => Effect.succeed(session) }
        const goals = RayaGoal.make({ ...input, sessions: client })
        yield* goals.create(sid, "Work")
        const calls: string[] = []
        const resume = () =>
          RayaGoalContinuation.resume({
            ...input,
            sessions: client,
            sessionID: sid,
            run: async (id) => {
              calls.push(id)
            },
          })
        const failed = yield* claim(
          input.storage,
          agent.id,
          Effect.void,
          (value, owner) =>
            Effect.gen(function* () {
              identity.runID = owner.id
              expect(yield* continuation({ ...input, session })).toBe(false)
              yield* owner.link(sid)
              expect(yield* continuation({ ...input, session })).toBe(false)
              yield* tasks.record({
                id: owner.id,
                agentID: agent.id,
                sessionID: sid,
                at: owner.at,
                scheduleVersion: 1,
                trigger,
                status: "running",
              })
              expect(yield* continuation({ ...input, session })).toBe(true)
              expect(yield* continuation({ ...input, session: { ...session, id: "wrong" } })).toBe(false)
              yield* resume()
              expect(calls).toEqual([sid])
              return yield* Effect.die("startup response lost")
            }),
          () => trigger,
        ).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* continuation({ ...input, session })).toBe(false)
        yield* resume()
        expect(calls).toEqual([sid])
        expect((yield* goals.get(sid))?.usage.continuations).toBe(1)
        const key = ["raya", "agent-claims", createHash("sha256").update(agent.id).digest("hex")]
        yield* input.storage.replace(key, { version: 1 })
        expect(yield* continuation({ ...input, session })).toBe(false)
        yield* input.storage.remove(key)
        expect(yield* continuation({ ...input, session })).toBe(true)
      }).pipe(Effect.provide(state(directory)))
    }),
  )
}

it.live("automatic resume requires matching linked history and live local queue ownership", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const tasks = RayaTask.make(input)
      const schedule = scheduler(input)
      const queue = RayaTaskQueue.make(input.database)
      const at = Date.now()
      const agent = yield* tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at } })
      const trigger = yield* schedule.prepare(agent.id, at)
      if (!trigger) throw new Error("Expected queued work")
      const sid = SessionID.make("ses_continuation_owner")
      const identity = { version: 2, agentID: agent.id, runID: "claim", scheduleVersion: 1, trigger }
      const session = {
        id: sid,
        slug: "routine",
        projectID: ProjectV2.ID.make("project"),
        directory: "/repo",
        title: "Routine",
        version: "test",
        time: { created: at, updated: at },
        metadata: { rayaRoutine: identity },
      }
      const client = { ...sessions, get: () => Effect.succeed(session) }
      const goals = RayaGoal.make({ ...input, sessions: client })
      yield* goals.create(sid, "Work")
      const calls: string[] = []
      let close:
        | ((event: { properties: { sessionID: SessionID; reason: "completed" | "error" } }) => Fiber.Fiber<void>)
        | undefined
      const bus = {
        subscribeCallback: (_event, callback) => {
          close = callback as typeof close
          return Effect.succeed(() => {})
        },
      } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
      yield* RayaGoalContinuation.subscribe({
        ...input,
        bus,
        sessions: client,
        run: async (id) => {
          calls.push(id)
        },
      })
      const resume = () =>
        RayaGoalContinuation.resume({
          ...input,
          sessions: client,
          sessionID: sid,
          run: async (id) => {
            calls.push(id)
          },
        })
      yield* resume()
      expect(calls).toEqual([])
      yield* schedule.reserve(trigger, "claim")
      yield* schedule.link(trigger, "claim", sid)
      yield* resume()
      expect(calls).toEqual([])
      yield* tasks.record({ id: "claim", agentID: agent.id, sessionID: sid, at, status: "running", trigger })
      yield* resume()
      expect(calls).toEqual([sid])
      if (!close) throw new Error("Expected turn-close listener")
      yield* Fiber.join(close({ properties: { sessionID: sid, reason: "error" } }))
      expect(calls).toEqual([sid, sid])
      expect((yield* goals.get(sid))?.usage.retries).toBe(1)
      expect((yield* goals.get(sid))?.usage.continuations).toBe(2)
      expect(yield* continuation({ storage: input.storage, session })).toBe(false)
      expect(yield* continuation({ ...input, session: { ...session, id: "another-session" } })).toBe(false)
      expect(
        yield* continuation({
          ...input,
          session: { ...session, metadata: { rayaRoutine: { ...identity, runID: "other" } } },
        }),
      ).toBe(false)
      expect(yield* continuation({ ...input, session: { ...session, metadata: { rayaRoutine: null } } })).toBe(false)
      const row = yield* queue.get(trigger.id)
      if (!row) throw new Error("Expected persisted owner")
      yield* input.database.db
        .update(RayaRoutineOccurrenceTable)
        .set({ owner: "foreign" })
        .where(eq(RayaRoutineOccurrenceTable.id, row.id))
        .run()
      yield* resume()
      yield* Fiber.join(close({ properties: { sessionID: sid, reason: "error" } }))
      yield* Fiber.join(close({ properties: { sessionID: sid, reason: "completed" } }))
      expect(calls).toEqual([sid, sid])
      expect((yield* goals.get(sid))?.usage.retries).toBe(1)
      expect((yield* goals.get(sid))?.usage.turns).toBe(0)
      yield* input.database.db
        .update(RayaRoutineOccurrenceTable)
        .set({ owner: row.owner, lease_until: at - 1 })
        .where(eq(RayaRoutineOccurrenceTable.id, row.id))
        .run()
      yield* resume()
      yield* Fiber.join(close({ properties: { sessionID: sid, reason: "error" } }))
      yield* Fiber.join(close({ properties: { sessionID: sid, reason: "completed" } }))
      expect(calls).toEqual([sid, sid])
      expect((yield* goals.get(sid))?.usage.continuations).toBe(2)
      expect((yield* goals.get(sid))?.status).toBe("active")
      yield* input.database.db
        .update(RayaRoutineOccurrenceTable)
        .set({ lease_until: Date.now() + 180_000 })
        .where(eq(RayaRoutineOccurrenceTable.id, row.id))
        .run()
      yield* RayaGoalContinuation.resume({
        ...input,
        storage: {
          ...input.storage,
          replace: (key, value) =>
            input.storage.replace(key, value).pipe(
              Effect.andThen(
                key[1] === "goal"
                  ? input.database.db
                      .update(RayaRoutineOccurrenceTable)
                      .set({ lease_until: at - 1 })
                      .where(eq(RayaRoutineOccurrenceTable.id, row.id))
                      .run()
                      .pipe(Effect.orDie, Effect.asVoid)
                  : Effect.void,
              ),
            ),
        },
        sessions: client,
        sessionID: sid,
        run: async (id) => {
          calls.push(id)
        },
      })
      expect(calls).toEqual([sid, sid])
      yield* input.database.db.delete(RayaRoutineOccurrenceTable).where(eq(RayaRoutineOccurrenceTable.id, row.id)).run()
      expect(yield* continuation({ ...input, session })).toBe(false)
      expect(
        yield* continuation({
          ...input,
          session: { ...session, metadata: { rayaRoutine: { ...identity, version: 1 } } },
        }),
      ).toBe(true)
      expect(yield* continuation({ ...input, session: { ...session, metadata: undefined } })).toBe(true)
      expect(
        yield* continuation({
          ...input,
          session: { ...session, metadata: { rayaRoutine: { ...identity, trigger: { kind: "manual" } } } },
        }),
      ).toBe(true)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live(
  "a selected calendar occurrence survives reopening and is reserved before an uncertain session attempt",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const at = Math.floor(Date.now() / 60_000) * 60_000
      const selected = yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const tasks = RayaTask.make(input)
        const agent = yield* tasks.create({
          name: "Calendar",
          objective: "Work",
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        })
        yield* input.storage.replace(
          ["raya", "agent"],
          [{ ...agent, createdAt: at - 86_400_000, scheduleUpdatedAt: at - 86_400_000 }],
        )
        const trigger = yield* scheduler(input).prepare(agent.id, at + 1000)
        if (!trigger) throw new Error("Expected a queued occurrence")
        return { agent, trigger }
      }).pipe(Effect.provide(state(directory)))
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const queue = RayaTaskQueue.make(input.database)
        const schedule = scheduler(input)
        expect(yield* schedule.prepare(selected.agent.id, at + 3_600_000)).toEqual(selected.trigger)
        const attempts: unknown[] = []
        const runner = RayaTaskRunner.make({
          ...input,
          sessions: {
            ...sessions,
            create: (input?: { metadata?: unknown }) =>
              Effect.sync(() => attempts.push(input?.metadata)).pipe(
                Effect.andThen(Effect.die("session response lost")),
              ),
          },
        })
        expect((yield* runner.preview(at + 3_600_000))[0]?.nextRun).toBe(at)
        expect(Exit.isFailure(yield* runner.tick(at + 3_600_000).pipe(Effect.exit))).toBe(true)
        const row = yield* queue.get(selected.trigger.id)
        expect(row?.state).toBe("starting")
        expect(row?.scheduled_at).toBe(at)
        expect(attempts).toEqual([
          {
            rayaRoutine: {
              version: 2,
              agentID: selected.agent.id,
              runID: row?.claim_id,
              scheduleVersion: 1,
              trigger: selected.trigger,
            },
          },
        ])
        yield* runner.tick(at + 3_660_000)
        expect(attempts).toHaveLength(1)
        expect((yield* runner.fire(selected.agent.id).pipe(Effect.flip))._tag).toBe("RayaTask.GuardError")
        yield* schedule.pulse(selected.agent.id)
        expect((yield* queue.get(selected.trigger.id))?.lease_until).toBe(row?.lease_until)
        expect((yield* runner.preview(Date.now() + 240_000))[0]?.note).toContain("expired lease")
        expect(yield* runner.tasks.runsFor(selected.agent.id)).toEqual([])
        if (!row?.claim_id) throw new Error("Expected persisted startup identity")
        expect((yield* runner.preview(Date.now() + 240_000))[0]?.execution).toEqual({
          state: "recovery",
          runID: row.claim_id,
        })
        expect((yield* RayaTaskSnapshot.make(input).get(row.claim_id)).runID).toBe(row.claim_id)
        yield* queue.publish({
          agentID: selected.agent.id,
          version: 2,
          occurrences: [{ at: at + 1, observedAt: at + 1 }],
        })
        const other = (yield* queue.pending(selected.agent.id, 2))[0]
        if (!other) throw new Error("Expected second occurrence")
        yield* queue.claim({
          id: other.id,
          claimID: "ambiguous",
          owner: "another",
          now: Date.now(),
          until: Date.now() + 180_000,
        })
        expect((yield* runner.preview(Date.now()))[0]?.execution).toEqual({ state: "recovery" })
      }).pipe(Effect.provide(state(directory)))
    }),
  30_000,
)

it.live("queued work obeys version changes and legacy consumption", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const tasks = RayaTask.make(input)
      const schedule = scheduler(input)
      const queue = RayaTaskQueue.make(input.database)
      const at = Date.now()
      const agent = yield* tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at } })
      const trigger = yield* schedule.prepare(agent.id, at)
      if (!trigger) throw new Error("Expected queued work")
      const changed = yield* tasks.update(agent.id, { schedule: { kind: "once", at: at + 60_000 } })
      expect((yield* schedule.check(changed, trigger).pipe(Effect.flip))._tag).toBe("RayaTask.GuardError")
      expect(yield* schedule.prepare(agent.id, at)).toBeUndefined()
      const newer = yield* schedule.prepare(agent.id, at + 60_000)
      if (!newer) throw new Error("Expected new version")
      expect(newer.id).not.toBe(trigger.id)
      yield* tasks.record({
        id: "legacy",
        agentID: agent.id,
        scheduleVersion: 2,
        at: at + 60_000,
        sessionID: SessionID.make("ses_legacy_queue"),
        status: "complete",
      })
      expect(yield* schedule.prepare(agent.id, at + 120_000)).toBeUndefined()
      expect((yield* queue.get(newer.id))?.state).toBe("skipped")
      expect((yield* queue.get(trigger.id))?.state).toBe("queued")
      yield* schedule.retire(agent.id)
      expect((yield* queue.get(trigger.id))?.state).toBe("skipped")
      expect((yield* queue.get(trigger.id))?.reason).toBe("Replaced by a newer schedule version.")
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("removal preserves recovery evidence and excludes startup, unfinished history and active queue work", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const tasks = RayaTask.make(input)
      const queue = RayaTaskQueue.make(input.database)
      const agent = yield* tasks.create({ name: "Remove", objective: "Work", schedule: { kind: "manual" } })
      yield* claim(input.storage, agent.id, Effect.void, () =>
        Effect.gen(function* () {
          expect((yield* tasks.remove(agent.id).pipe(Effect.flip))._tag).toBe("RayaTask.GuardError")
          expect((yield* tasks.get(agent.id)).id).toBe(agent.id)
        }),
      )
      const run = yield* tasks.record({
        id: "unfinished-removal",
        agentID: agent.id,
        at: Date.now(),
        sessionID: SessionID.make("ses_unfinished_removal"),
        status: "running",
      })
      expect((yield* tasks.remove(agent.id).pipe(Effect.flip))._tag).toBe("RayaTask.GuardError")
      expect(yield* tasks.runsFor(agent.id)).toEqual([run])
      yield* tasks.transition(run, { ...run, status: "complete" })
      yield* queue.publish({ agentID: agent.id, version: 1, occurrences: [{ at: 1000, observedAt: 1000 }] })
      const row = (yield* queue.pending(agent.id, 1))[0]
      yield* queue.claim({ id: row.id, claimID: "unresolved", owner: "foreign", now: 1000, until: 2000 })
      expect((yield* tasks.remove(agent.id).pipe(Effect.flip))._tag).toBe("RayaTask.GuardError")
      expect((yield* queue.get(row.id))?.claim_id).toBe("unresolved")
      yield* queue.link({ id: row.id, claimID: "unresolved", sessionID: run.sessionID, now: 2001 })
      yield* queue.settle({ id: row.id, claimID: "unresolved", sessionID: run.sessionID, now: 2002 })
      yield* tasks.remember(agent.id, "Saved context")
      expect(yield* tasks.remove(agent.id)).toBe(true)
      expect(yield* tasks.recall(agent.id)).toBe("Saved context")
      expect((yield* tasks.runsFor(agent.id))[0]?.status).toBe("complete")
      expect((yield* tasks.get(agent.id).pipe(Effect.flip))._tag).toBe("RayaTask.NotFoundError")
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("removed-routine queue cleanup resumes after reopening and a failed receipt acknowledgement", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const saved = yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const tasks = RayaTask.make(input)
      const queue = RayaTaskQueue.make(input.database)
      const agent = yield* tasks.create({ name: "Remove queue", objective: "Work", schedule: { kind: "manual" } })
      for (const version of [1, 2])
        yield* queue.publish({ agentID: agent.id, version, occurrences: [{ at: 1000, observedAt: 1000 }] })
      const rows = [...(yield* queue.pending(agent.id, 1)), ...(yield* queue.pending(agent.id, 2))]
      yield* tasks.remove(agent.id)
      expect((yield* removals(input.storage).pending()).map((item) => item.agentID)).toEqual([agent.id])
      expect((yield* queue.get(rows[0].id))?.state).toBe("queued")
      return { id: agent.id, rows: rows.map((row) => row.id) }
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const queue = RayaTaskQueue.make(input.database)
      const broken = scheduler({
        ...input,
        storage: {
          ...input.storage,
          replace: (key, value) =>
            key.join("/") === "raya/agent-removals"
              ? Effect.die(new Error("Receipt acknowledgement unavailable"))
              : input.storage.replace(key, value),
        },
      })
      expect(Exit.isFailure(yield* broken.clean().pipe(Effect.exit))).toBe(true)
      for (const id of saved.rows) {
        expect((yield* queue.get(id))?.state).toBe("skipped")
        expect((yield* queue.get(id))?.reason).toBe("Routine removed from the roster.")
      }
      expect(yield* removals(input.storage).pending()).toHaveLength(1)
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const queue = RayaTaskQueue.make(input.database)
      const before = yield* queue.get(saved.rows[0])
      yield* RayaTaskRunner.make({ ...input, sessions }).tick(Date.now())
      expect(yield* removals(input.storage).pending()).toEqual([])
      expect(yield* queue.get(saved.rows[0])).toEqual(before)
      expect((yield* queue.cursor(saved.id, 1))?.through).toBe(1000)
      const archived = (yield* RayaTask.make(input).page()).items
      expect(archived.map((item) => item.definition.id)).toEqual([saved.id])
      expect(archived[0].definition.name).toBe("Remove queue")
      expect(archived[0].definition.execution).toBeUndefined()
      expect(archived[0].definition.nextRun).toBeUndefined()
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("a failed roster removal cannot retire the still-present routine's queued work", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const tasks = RayaTask.make(input)
      const queue = RayaTaskQueue.make(input.database)
      const agent = yield* tasks.create({ name: "Failed removal", objective: "Work", schedule: { kind: "manual" } })
      yield* queue.publish({ agentID: agent.id, version: 1, occurrences: [{ at: 1000, observedAt: 1000 }] })
      const rows = yield* queue.pending(agent.id, 1)
      const broken = RayaTask.make({
        ...input,
        storage: {
          ...input.storage,
          replace: (key, value) =>
            key.join("/") === "raya/agent"
              ? Effect.die(new Error("Roster write unavailable"))
              : input.storage.replace(key, value),
        },
      })
      expect(Exit.isFailure(yield* broken.remove(agent.id).pipe(Effect.exit))).toBe(true)
      expect(yield* removals(input.storage).pending()).toHaveLength(1)
      yield* scheduler(input).clean()
      expect((yield* tasks.page()).items).toEqual([])
      expect((yield* tasks.get(agent.id)).id).toBe(agent.id)
      expect(yield* queue.pending(agent.id, 1)).toEqual(rows)
      expect(yield* removals(input.storage).pending()).toHaveLength(1)
      const roster = yield* input.storage.read(["raya", "agent"])
      yield* input.storage.remove(["raya", "agent"])
      expect(Exit.isFailure(yield* scheduler(input).clean().pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* tasks.page().pipe(Effect.exit))).toBe(true)
      expect(yield* queue.pending(agent.id, 1)).toEqual(rows)
      yield* input.storage.replace(["raya", "agent"], roster)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("archive integration validates legacy data once and stops writing the source file", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const saved = yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const tasks = RayaTask.make(input)
      const agent = yield* tasks.create({ name: "Still active", objective: "Work", schedule: { kind: "manual" } })
      const source = [
        { version: 1, archivedAt: 1000, definition: { ...agent, id: "legacy-removed" } },
        { version: 1, archivedAt: 2000, definition: agent },
      ]
      yield* input.storage.replace(
        ["raya", "agent-archive"],
        [{ version: 1, archivedAt: 1000, definition: { id: "invalid" } }],
      )
      expect(Exit.isFailure(yield* tasks.page().pipe(Effect.exit))).toBe(true)
      expect(yield* indexed(input.database).ready()).toBe(false)
      yield* input.storage.replace(["raya", "agent-archive"], source)
      expect((yield* tasks.page()).items.map((item) => item.definition.id)).toEqual(["legacy-removed"])
      expect(yield* indexed(input.database).ready()).toBe(true)
      expect((yield* RayaTask.make({ storage: input.storage }).remove(agent.id).pipe(Effect.flip))._tag).toBe(
        "RayaTask.GuardError",
      )
      expect(yield* tasks.get(agent.id)).toEqual(agent)
      return { source, id: agent.id }
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({
        database,
        storage: {
          ...storage,
          read: (key) =>
            key.join("/") === "raya/agent-archive" ? Effect.die(new Error("Legacy archive reread")) : storage.read(key),
          replace: (key, value) =>
            key.join("/") === "raya/agent-archive"
              ? Effect.die(new Error("Legacy archive rewrite"))
              : storage.replace(key, value),
        },
      })
      expect((yield* tasks.page()).items.map((item) => item.definition.id)).toEqual(["legacy-removed"])
      const newer = yield* tasks.create({
        name: "Indexed removal",
        objective: "New work",
        schedule: { kind: "manual" },
      })
      yield* tasks.remove(newer.id)
      expect((yield* tasks.page()).items.map((item) => item.definition.id)).toEqual([newer.id, "legacy-removed"])
      expect((yield* tasks.page({ agentID: saved.id })).items).toEqual([])
      expect(yield* storage.read(["raya", "agent-archive"])).toEqual(saved.source)
      yield* database.db.run(
        sql`UPDATE raya_routine_archive SET definition = '{"id":"wrong"}' WHERE id = 'legacy-removed'`,
      )
      expect(Exit.isFailure(yield* tasks.page({ agentID: "legacy-removed" }).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("an indexed archive write failure prevents roster removal and preserves history", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage, database })
      const agent = yield* tasks.create({
        name: "Archive failure",
        objective: "Keep this definition",
        schedule: { kind: "manual" },
      })
      const run = yield* tasks.record({
        id: "archive-history",
        agentID: agent.id,
        at: Date.now(),
        sessionID: SessionID.make("ses_archive_failure"),
        status: "complete",
      })
      yield* database.db.run(
        sql`CREATE TRIGGER fail_archive BEFORE INSERT ON raya_routine_archive BEGIN SELECT RAISE(ABORT, 'Archive unavailable'); END`,
      )
      expect(Exit.isFailure(yield* tasks.remove(agent.id).pipe(Effect.exit))).toBe(true)
      expect(yield* tasks.get(agent.id)).toEqual(agent)
      expect(yield* tasks.runsFor(agent.id)).toEqual([run])
      expect((yield* tasks.page()).items).toEqual([])
      expect(yield* removals(storage).pending()).toEqual([])
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("polling retires obsolete queued work for disabled and manual routines", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const runner = RayaTaskRunner.make({ ...input, sessions })
      const queue = RayaTaskQueue.make(input.database)
      const at = Date.now()
      for (const manual of [false, true]) {
        const agent = yield* runner.tasks.create({ name: "Retire", objective: "Work", schedule: { kind: "once", at } })
        yield* queue.publish({
          agentID: agent.id,
          version: 1,
          occurrences: [
            { at, observedAt: at },
            { at: at + 1, observedAt: at + 1 },
          ],
        })
        const rows = yield* queue.pending(agent.id, 1)
        yield* queue.claim({ id: rows[0].id, claimID: "retained", owner: "foreign", now: at, until: at + 1000 })
        yield* runner.tasks.update(agent.id, {
          enabled: false,
          schedule: manual ? { kind: "manual" } : { kind: "once", at: at + 60_000 },
        })
        yield* queue.publish({ agentID: agent.id, version: 2, occurrences: [{ at, observedAt: at }] })
        yield* runner.tick(at)
        expect((yield* queue.get(rows[0].id))?.state).toBe("starting")
        expect((yield* queue.get(rows[1].id))?.state).toBe("skipped")
        expect(yield* queue.pending(agent.id, 2)).toHaveLength(1)
        yield* runner.tick(at + 1)
        expect((yield* queue.get(rows[0].id))?.claim_id).toBe("retained")
        expect(yield* queue.pending(agent.id, 2)).toHaveLength(1)
      }
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("a terminal run reconciles its queue entry but an active foreign owner is not resumed", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = { storage: yield* Storage.Service, database: yield* Database.Service }
      const queue = RayaTaskQueue.make(input.database)
      const runner = RayaTaskRunner.make({ ...input, sessions })
      const at = Date.now() - 10_000
      const agent = yield* runner.tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at } })
      const trigger = yield* scheduler(input).prepare(agent.id, at)
      if (!trigger) throw new Error("Expected queued work")
      const sid = SessionID.make("ses_foreign_queue")
      yield* queue.claim({ id: trigger.id, claimID: "foreign", owner: "another-backend", now: at, until: at + 1000 })
      yield* queue.link({ id: trigger.id, claimID: "foreign", sessionID: sid, now: at + 1000 })
      const run = yield* runner.tasks.record({
        id: "foreign",
        agentID: agent.id,
        sessionID: sid,
        at,
        status: "running",
        trigger,
      })
      const goal = {
        objective: "Work",
        status: "active",
        createdAt: at,
        updatedAt: at,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [],
      }
      yield* input.storage.replace(["raya", "goal", sid], goal)
      expect(yield* scheduler(input).owned(run)).toBe(false)
      yield* runner.revive()
      expect((yield* queue.get(trigger.id))?.state).toBe("linked")
      yield* runner.tasks.transition(run, { ...run, status: "complete" })
      yield* input.storage.replace(["raya", "goal", sid], { ...goal, status: "complete" })
      yield* runner.tick(Date.now())
      expect((yield* queue.get(trigger.id))?.state).toBe("complete")
      expect(yield* queue.active(agent.id)).toEqual([])
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("interruption after history publication retains one linked occurrence and session identity", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const sid = SessionID.make("ses_linked_queue")
      const now = Date.now()
      const metadata: unknown[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage: {
          ...storage,
          replace: (key, value) =>
            storage.replace(key, value).pipe(Effect.andThen(key[1] === "agent-runs" ? Effect.interrupt : Effect.void)),
        },
        sessions: {
          ...sessions,
          create: (input?: { metadata?: Record<string, unknown> }) =>
            Effect.sync(() => {
              metadata.push(input?.metadata)
              return {
                id: sid,
                slug: "routine",
                projectID: ProjectV2.ID.make("project"),
                directory: "/repo",
                title: "Routine",
                version: "test",
                time: { created: now, updated: now },
                metadata: input?.metadata,
              }
            }),
        },
      })
      const agent = yield* runner.tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at: now } })
      expect(Exit.isFailure(yield* runner.tick(now).pipe(Effect.exit))).toBe(true)
      const history = yield* RayaTask.make({ storage }).runsFor(agent.id)
      expect(history).toHaveLength(1)
      const row = (yield* RayaTaskQueue.make(database).active(agent.id))[0]
      expect(row?.state).toBe("linked")
      expect(row?.session_id).toBe(sid)
      expect(row?.claim_id).toBe(history[0]?.id)
      expect(metadata).toHaveLength(1)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("legacy unzoned calendars retain queued evidence but require review before automatic admission", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const saved = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage, database })
      const clock = scheduler({ storage, database })
      const agent = yield* tasks.create({
        name: "Legacy calendar",
        objective: "Work",
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      })
      const at = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
      const queued = yield* clock.prepare(agent.id, at)
      expect(queued).toBeDefined()
      const legacy = { ...agent, schedule: { kind: "cron" as const, expr: "* * * * *" }, note: "Preserved note" }
      yield* storage.replace(["raya", "agent"], [legacy])
      return { legacy, queued: queued!, at }
    }).pipe(Effect.provide(state(directory)))
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage, database })
      const clock = scheduler({ storage, database })
      const queue = RayaTaskQueue.make(database)
      expect(yield* tasks.get(saved.legacy.id)).toEqual(saved.legacy)
      expect(RayaTask.next(saved.legacy, saved.at)).toBeUndefined()
      expect(yield* tasks.ready(saved.at)).toEqual([])
      const preview = (yield* tasks.preview(saved.at))[0]
      expect(preview.nextRun).toBeUndefined()
      expect(preview.note).toContain("timezone review")
      expect(preview.note).toContain("Preserved note")
      const runner = RayaTaskRunner.make({ storage, database, sessions })
      const shown = (yield* runner.preview(saved.at))[0]
      expect(shown.nextRun).toBeUndefined()
      expect(shown.note).toContain("timezone review")
      expect(yield* clock.prepare(saved.legacy.id, saved.at)).toBeUndefined()
      expect(yield* clock.check(saved.legacy, saved.queued).pipe(Effect.flip)).toMatchObject({
        kind: "schedule",
        field: "timezone",
      })
      expect((yield* queue.get(saved.queued.id).pipe(Effect.orDie))?.state).toBe("queued")
      expect((yield* queue.get(saved.queued.id).pipe(Effect.orDie))?.timezone).toBe("UTC")
      expect((yield* tasks.launchable(saved.legacy.id)).id).toBe(saved.legacy.id)
      expect(yield* tasks.list()).toEqual([saved.legacy])
      const changed = yield* tasks.update(saved.legacy.id, {
        schedule: { ...saved.legacy.schedule, tz: "America/Toronto" },
        expectedSchedule: saved.legacy.schedule,
        expectedScheduleVersion: saved.legacy.scheduleVersion ?? 1,
      })
      expect(changed.scheduleVersion).toBe((saved.legacy.scheduleVersion ?? 1) + 1)
      expect(yield* clock.check(changed, saved.queued).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect((yield* clock.prepare(changed.id, saved.at + 60_000))?.tz).toBe("America/Toronto")
      expect((yield* queue.get(saved.queued.id).pipe(Effect.orDie))?.scheduled_at).toBe(saved.at)
    }).pipe(Effect.provide(state(directory)))
  }),
)
