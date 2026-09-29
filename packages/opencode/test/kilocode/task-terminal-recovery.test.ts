import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { sql } from "drizzle-orm"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Git } from "@/git"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { scheduler } from "@/kilocode/task/scheduler"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const layers = (root: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(root, "storage")),
    Database.layerFromPath(path.join(root, "queue.sqlite")),
  )
const sessions = {
  create: () => Effect.die("unexpected session creation"),
  get: () => Effect.die("unexpected session read"),
  messages: () => Effect.succeed([]),
  children: () => Effect.succeed([]),
}
const client = (
  inputs: Array<{
    sid: SessionID
    agent: string
    run: string
    version: number
    trigger: RayaTask.Trigger
  }>,
) => ({
  ...sessions,
  get: (id: SessionID) => {
    const input = inputs.find((item) => item.sid === id)
    return input
      ? Effect.succeed({
          id,
          slug: "terminal-restart",
          title: "Terminal restart",
          projectID: ProjectV2.ID.make("project"),
          directory: "/tmp",
          version: "test",
          time: { created: Date.now(), updated: Date.now() },
          metadata: {
            rayaRoutine: {
              version: 2 as const,
              agentID: input.agent,
              runID: input.run,
              scheduleVersion: input.version,
              trigger: input.trigger,
            },
          },
        })
      : Effect.die("unexpected session read")
  },
})

it.live(
  "restart replays exact terminal settlement without repeating continuing work",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const sid = SessionID.make("ses_terminal_restart")
      const fixture = path.join(import.meta.dir, "fixtures", "task-terminal-execution.ts")
      const saved = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const runner = RayaTaskRunner.make({ database, storage, sessions })
        const now = Date.now()
        const agent = yield* runner.tasks.create({
          name: "Terminal restart",
          objective: "Finish once",
          access: "brief",
          schedule: { kind: "once", at: now },
        })
        const trigger = yield* scheduler({ database, storage }).prepare(agent.id, now)
        if (!trigger) throw new Error("Expected one scheduled occurrence")
        const run = crypto.randomUUID()
        const queue = RayaTaskQueue.make(database)
        yield* queue.claim({ id: trigger.id, claimID: run, owner: "stopped-backend", now, until: now + 180_000 })
        yield* queue.link({ id: trigger.id, claimID: run, sessionID: sid, now })
        yield* RayaGoal.make({ storage, sessions }).create(sid, "Finish once")
        const goal = yield* RayaGoal.make({ storage, sessions }).get(sid)
        if (!goal) throw new Error("Expected saved goal")
        yield* storage.replace(["raya", "goal", sid], {
          ...goal,
          status: "complete",
          audit: { summary: "Finished exactly once.", verifiedAt: now, requirements: [] },
          updatedAt: now,
        })
        yield* RayaTaskSnapshot.make({ storage }).save({
          version: 2,
          runID: run,
          agentID: agent.id,
          at: now,
          definition: agent,
          objective: "Finish once",
        })
        yield* runner.tasks.record({
          id: run,
          agentID: agent.id,
          sessionID: sid,
          at: now,
          scheduleVersion: agent.scheduleVersion ?? 1,
          trigger,
          status: "running",
        })
        const code = yield* spawner.exitCode(
          ChildProcess.make(process.execPath, [fixture, path.join(root, "storage"), agent.id, run, sid], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: false,
          }),
        )
        expect(Number(code)).toBe(0)
        yield* database.db.run(sql`
          CREATE TRIGGER fail_terminal_occurrence
          BEFORE UPDATE OF state ON raya_routine_occurrence
          WHEN NEW.state = 'complete'
          BEGIN
            SELECT RAISE(ABORT, 'injected terminal settlement failure');
          END
        `)
        expect(Exit.isFailure(yield* runner.settle(sid).pipe(Effect.exit))).toBe(true)
        expect((yield* runner.tasks.runsFor(agent.id)).find((item) => item.id === run)?.status).toBe("complete")
        expect((yield* queue.get(trigger.id))?.state).toBe("linked")
        expect((yield* RayaTaskInbox.make(database).page(agent.id)).messages).toHaveLength(0)
        expect(yield* storage.list(["raya", "agent-executions"])).toHaveLength(1)
        const newer = "run_terminal_newer"
        yield* runner.tasks.record({
          id: newer,
          agentID: agent.id,
          sessionID: SessionID.make("ses_terminal_newer"),
          at: now + 1,
          scheduleVersion: agent.scheduleVersion ?? 1,
          trigger: { kind: "manual" },
          status: "complete",
          outcome: { kind: "code", summary: "Newer retained history.", cost: 0 },
        })
        return { agent: agent.id, occurrence: trigger.id, run, newer, trigger, version: agent.scheduleVersion ?? 1 }
      }).pipe(Effect.provide(layers(root)), Effect.scoped)

      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const turns: string[] = []
        yield* database.db.run(sql`DROP TRIGGER fail_terminal_occurrence`)
        const runner = RayaTaskRunner.make({
          database,
          storage,
          sessions: client([
            {
              sid,
              agent: saved.agent,
              run: "changed-terminal-run",
              version: saved.version,
              trigger: saved.trigger,
            },
          ]),
          continuation: () => Effect.sync(() => turns.push("unexpected")),
        })
        yield* runner.revive()
        expect(turns).toEqual([])
        expect((yield* RayaTaskQueue.make(database).get(saved.occurrence))?.state).toBe("linked")
        expect((yield* RayaTaskInbox.make(database).page(saved.agent)).messages).toHaveLength(0)
        expect(yield* storage.list(["raya", "agent-executions"])).toHaveLength(1)
      }).pipe(Effect.provide(layers(root)), Effect.scoped)

      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const turns: string[] = []
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const gate = { held: false }
        const guarded: Storage.Interface = {
          ...storage,
          read: <T>(key: string[]) =>
            Effect.gen(function* () {
              if (!gate.held && key[0] === "raya" && key[1] === "agent-runs") {
                const keys = yield* storage.list(["raya", "agent-executions"])
                const records = yield* Effect.forEach(keys, (key) =>
                  storage.read<{ state?: string }>(key).pipe(Effect.orElseSucceed((): { state?: string } => ({}))),
                )
                if (records.some((record) => record.state === "recovering")) {
                  gate.held = true
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }
              }
              return yield* storage.read<T>(key)
            }),
        }
        const resumed = client([
          {
            sid,
            agent: saved.agent,
            run: saved.run,
            version: saved.version,
            trigger: saved.trigger,
          },
        ])
        const runner = RayaTaskRunner.make({
          database,
          storage: guarded,
          sessions: resumed,
          continuation: () => Effect.sync(() => turns.push("unexpected")),
        })
        const first = yield* runner.revive().pipe(Effect.forkChild)
        const concurrent = yield* Effect.gen(function* () {
          yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
          yield* runner.revive()
          return (yield* RayaTaskInbox.make(database).page(saved.agent)).messages
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.exit)
        const joined = yield* Fiber.await(first)
        expect(Exit.isSuccess(concurrent)).toBe(true)
        expect(Exit.isSuccess(joined)).toBe(true)
        if (Exit.isSuccess(concurrent)) expect(concurrent.value).toHaveLength(0)
        yield* runner.revive()
        expect(turns).toEqual([])
        expect((yield* RayaTaskQueue.make(database).get(saved.occurrence))?.state).toBe("complete")
        expect((yield* runner.tasks.runsFor(saved.agent)).find((item) => item.id === saved.run)?.status).toBe(
          "complete",
        )
        expect((yield* runner.tasks.runsFor(saved.agent)).at(-1)?.id).toBe(saved.newer)
        expect(
          (yield* RayaTaskInbox.make(database).page(saved.agent)).messages.filter(
            (item) => item.source === `report:${saved.run}`,
          ),
        ).toHaveLength(1)
        expect(yield* storage.list(["raya", "agent-executions"])).toHaveLength(0)
      }).pipe(Effect.provide(layers(root)), Effect.scoped)
    }),
  60_000,
)

it.live(
  "releases earlier recovery admission when a later retained identity is malformed",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const dir = path.join(root, "storage")
      const fixture = path.join(import.meta.dir, "fixtures", "task-terminal-execution.ts")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const agent = yield* tasks.create({
          name: "Retained terminal pair",
          objective: "Recover both receipts",
          access: "brief",
          schedule: { kind: "manual" },
        })
        const now = Date.now()
        const rows = [
          { id: "run_terminal_pair_a", sid: SessionID.make("ses_terminal_pair_a"), at: now },
          { id: "run_terminal_pair_b", sid: SessionID.make("ses_terminal_pair_b"), at: now + 1 },
        ]
        for (const row of rows) {
          const run = {
            id: row.id,
            agentID: agent.id,
            sessionID: row.sid,
            at: row.at,
            scheduleVersion: agent.scheduleVersion ?? 1,
            trigger: { kind: "manual" as const },
            status: "complete" as const,
            outcome: { kind: "code" as const, summary: "Saved terminal receipt.", cost: 0 },
          }
          yield* tasks.record(run)
          yield* RayaTaskSnapshot.make({ storage }).save({
            version: 2,
            runID: run.id,
            agentID: agent.id,
            at: run.at,
            definition: agent,
            objective: agent.objective,
          })
          yield* RayaGoal.make({ storage, sessions }).create(row.sid, agent.objective)
          const goal = yield* RayaGoal.make({ storage, sessions }).get(row.sid)
          if (!goal) throw new Error("Expected saved goal")
          yield* storage.replace(["raya", "goal", row.sid], {
            ...goal,
            status: "complete",
            audit: { summary: "Saved terminal receipt.", verifiedAt: row.at, requirements: [] },
            updatedAt: row.at,
          })
          const code = yield* spawner.exitCode(
            ChildProcess.make(process.execPath, [fixture, dir, agent.id, row.id, row.sid], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              detached: false,
            }),
          )
          expect(Number(code)).toBe(0)
        }
        const keys = yield* storage.list(["raya", "agent-executions"])
        const records = yield* Effect.forEach(keys, (key) =>
          storage
            .read<Record<string, unknown> & { runID: string; agentID: string }>(key)
            .pipe(Effect.map((record) => ({ key, record }))),
        )
        const second = records.find((entry) => entry.record.runID === rows[1].id)
        if (!second) throw new Error("Expected second retained execution")
        yield* storage.replace(second.key, { ...second.record, agentID: "changed-agent" })
        const resumed = client(
          rows.map((row) => ({
            sid: row.sid,
            agent: agent.id,
            run: row.id,
            version: agent.scheduleVersion ?? 1,
            trigger: { kind: "manual" as const },
          })),
        )
        const runner = RayaTaskRunner.make({ database, storage, sessions: resumed })
        expect(Exit.isFailure(yield* runner.revive().pipe(Effect.exit))).toBe(true)
        expect((yield* RayaTaskInbox.make(database).page(agent.id)).messages).toHaveLength(0)
        yield* storage.replace(second.key, second.record)
        yield* runner.revive()
        const reports = (yield* RayaTaskInbox.make(database).page(agent.id)).messages.filter((item) =>
          item.source.startsWith("report:run_terminal_pair_"),
        )
        expect(reports).toHaveLength(2)
        expect(yield* storage.list(["raya", "agent-executions"])).toHaveLength(0)
      }).pipe(Effect.provide(layers(root)), Effect.scoped)
    }),
  90_000,
)

it.live(
  "restart holds queued work while a terminal run still has a live continuing body",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const agent = yield* tasks.create({
          name: "Held terminal",
          objective: "Finish before the next request",
          access: "brief",
          schedule: { kind: "manual" },
        })
        const sid = SessionID.make("ses_terminal_held")
        const run = {
          id: "run_terminal_held",
          agentID: agent.id,
          sessionID: sid,
          at: Date.now(),
          scheduleVersion: agent.scheduleVersion ?? 1,
          trigger: { kind: "manual" as const },
          status: "complete" as const,
          outcome: { kind: "code" as const, summary: "Terminal receipt saved.", cost: 0 },
        }
        yield* tasks.record(run)
        yield* RayaTaskSnapshot.make({ storage }).save({
          version: 2,
          runID: run.id,
          agentID: agent.id,
          at: run.at,
          definition: agent,
          objective: agent.objective,
        })
        yield* RayaGoal.make({ storage, sessions }).create(sid, agent.objective)
        const goal = yield* RayaGoal.make({ storage, sessions }).get(sid)
        if (!goal) throw new Error("Expected saved goal")
        yield* storage.replace(["raya", "goal", sid], {
          ...goal,
          status: "complete",
          audit: { summary: "Terminal receipt saved.", verifiedAt: run.at, requirements: [] },
          updatedAt: run.at,
        })
        const inbox = RayaTaskInbox.make(database)
        yield* inbox.publish({ agentID: agent.id, source: "queued_after_terminal", kind: "user", body: "Next work" })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const execution = RayaTaskExecution.make(storage)
        const body = yield* execution
          .enter(
            run,
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const runner = RayaTaskRunner.make({
          database,
          storage,
          sessions: client([{ sid, agent: agent.id, run: run.id, version: run.scheduleVersion, trigger: run.trigger }]),
          continuation: () => Effect.die("queued work started before its prior body joined"),
        })
        yield* runner.revive()
        expect((yield* inbox.pending(agent.id))?.source).toBe("queued_after_terminal")
        expect(
          (yield* inbox.page(agent.id)).messages.filter((item) => item.source === `report:${run.id}`),
        ).toHaveLength(0)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(body)
        yield* runner.revive()
        expect((yield* inbox.pending(agent.id))?.source).toBe("queued_after_terminal")
        expect(yield* execution.retained(run)).toBe(true)
        yield* execution.finish(run)
      }).pipe(Effect.provide(layers(root)), Effect.scoped)
    }),
  60_000,
)

it.live(
  "terminal cleanup removes only a stopped idle owner and retains active or legacy uncertainty",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const dir = path.join(root, "storage")
      const fixture = path.join(import.meta.dir, "fixtures", "task-terminal-execution.ts")
      const idle = { id: "run_terminal_idle", agentID: "agent_terminal", sessionID: SessionID.make("ses_idle") }
      const active = { id: "run_terminal_active", agentID: "agent_terminal", sessionID: SessionID.make("ses_active") }
      for (const [owner, mode] of [
        [idle, "idle"],
        [active, "active"],
      ] as const) {
        const code = yield* spawner.exitCode(
          ChildProcess.make(process.execPath, [fixture, dir, owner.agentID, owner.id, owner.sessionID, mode], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: false,
          }),
        )
        expect(Number(code)).toBe(0)
      }
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const permit = yield* execution.terminal(idle)
        expect(permit).toBeDefined()
        if (!permit) throw new Error("Expected stopped idle terminal ownership")
        yield* execution.recover(permit, Effect.void)
        expect(yield* execution.terminal(active)).toBeUndefined()
        const keys = yield* storage.list(["raya", "agent-executions"])
        expect(keys).toHaveLength(1)
        const record = yield* storage.read<Record<string, unknown>>(keys[0])
        const legacy = { ...record }
        delete legacy.state
        yield* storage.replace(keys[0], legacy)
        expect(yield* execution.terminal(active)).toBeUndefined()
        expect(yield* storage.list(["raya", "agent-executions"])).toHaveLength(1)
        const live = { id: "run_terminal_live", agentID: "agent_terminal", sessionID: SessionID.make("ses_live") }
        expect(yield* execution.enter(live, Effect.succeed("joined"))).toBe("joined")
        expect(yield* execution.terminal(live)).toBeUndefined()
        yield* execution.finish(live)
        expect(yield* storage.list(["raya", "agent-executions"])).toHaveLength(1)
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }),
  60_000,
)
