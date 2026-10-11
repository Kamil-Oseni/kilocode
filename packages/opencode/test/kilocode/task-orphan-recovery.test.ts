import path from "node:path"
import { createHash } from "node:crypto"
import { expect } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaGoal } from "@/kilocode/goal"
import { stopped } from "@/kilocode/task/owner"
import { profile } from "./fixtures/task-orphan-profile"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

for (const kind of ["manual", "event"] as const)
  for (const fault of ["none", "foreign", "ambiguous", "unbound", "replacement", "race"] as const)
    it.live(
      `${kind} linked orphan recovery ${fault} preserves original identity and never replays work`,
      () =>
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const child = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [
              path.join(import.meta.dir, "fixtures", "task-orphan-start.ts"),
              dir,
              kind,
            ]),
          )
          const joined = yield* Effect.all([
            child.exitCode,
            Stream.runCollect(child.stdout),
            Stream.runCollect(child.stderr),
          ])
          if (joined[0] !== 23)
            throw new Error(
              `Original startup exited ${joined[0]} before boundary: ${Buffer.concat([...joined[2]])
                .toString()
                .slice(-16000)}`,
            )
          expect(Number(joined[0])).toBe(23)
          const calls: string[] = []
          const read = Effect.gen(function* () {
            const storage = yield* Storage.Service
            const database = yield* Database.Service
            const sessions = yield* Session.Service
            const goals = RayaGoal.make({ storage, database, sessions })
            const replaced = { done: false }
            const guarded = {
              ...storage,
              replace: (key: string[], value: unknown) =>
                storage.replace(key, value).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      if (fault !== "race" || replaced.done || key[0] !== "raya" || key[1] !== "agent-runs") return
                      replaced.done = true
                      const claim = yield* storage.read<{ sessionID: string }>(["raya", "agent-claims", hash(key[2])])
                      const sid = SessionID.make(claim.sessionID)
                      const goal = yield* goals.get(sid)
                      if (!goal?.intent) throw new Error("Actual original goal intent absent")
                      yield* goals.clear(sid, goal.intent)
                      yield* goals.create(sid, goal.objective)
                    }).pipe(Effect.orDie),
                  ),
                ),
            }
            const runner = RayaTaskRunner.make({
              storage: guarded,
              database,
              sessions,
              continuation: (run) => Effect.sync(() => calls.push(run.id)),
            })
            const worker = (yield* runner.tasks.list())[0]
            if (!worker) throw new Error("Original worker absent")
            const key = ["raya", "agent-claims", hash(worker.id)]
            const claim = yield* storage.read<{ id: string; sessionID: string; owner: unknown }>(key)
            expect(stopped(claim.owner)).toBe(true)
            const session = (yield* sessions.list({ kind: "all" })).find((row) => row.id === claim.sessionID)
            if (!session) throw new Error("Original real session absent")
            const goal = yield* goals.get(session.id)
            expect(goal?.status).toBe("active")
            expect(yield* runner.tasks.runsFor(worker.id)).toEqual([])
            if (fault === "foreign")
              yield* database.db
                .update(SessionTable)
                .set({
                  metadata: {
                    rayaRoutine: {
                      version: 1,
                      agentID: "foreign",
                      runID: claim.id,
                      scheduleVersion: 1,
                      trigger: { kind: "manual" },
                    },
                  },
                })
                .where(eq(SessionTable.id, session.id))
                .run()
            if (fault === "ambiguous")
              yield* sessions.create({ title: "Conflicting association", metadata: session.metadata })
            if (fault === "unbound") {
              if (!goal) throw new Error("Actual original goal absent")
              const legacy = { ...goal }
              delete legacy.routine
              yield* storage.replace(["raya", "goal", session.id], legacy)
            }
            if (fault === "replacement") {
              if (!goal?.intent) throw new Error("Actual original goal intent absent")
              yield* goals.clear(session.id, goal.intent)
              yield* goals.create(session.id, goal.objective)
            }
            const before = yield* goals.get(session.id)
            const result = yield* runner.resolve(worker.id, claim.id).pipe(Effect.exit)
            if (fault !== "none") {
              expect(Exit.isFailure(result)).toBe(true)
              expect(yield* storage.read(key)).toEqual(claim)
              const retained = yield* goals.get(session.id)
              if (fault !== "race") expect(retained).toEqual(before)
              if (fault === "race") {
                expect(replaced.done).toBe(true)
                expect(retained?.status).toBe("active")
                expect(retained?.intent).not.toBe(goal?.intent)
                expect(retained?.routine).toBeUndefined()
              }
              const runs = yield* runner.tasks.runsFor(worker.id)
              expect(runs).toHaveLength(fault === "race" ? 1 : 0)
              expect((yield* RayaTaskInbox.make(database).page(worker.id)).messages).toEqual([])
              expect(Exit.isFailure(yield* runner.resolve(worker.id, claim.id).pipe(Effect.exit))).toBe(true)
              expect(yield* storage.read(key)).toEqual(claim)
              expect(yield* goals.get(session.id)).toEqual(retained)
              expect(yield* runner.tasks.runsFor(worker.id)).toEqual(runs)
              return { worker, session, claim, goal: retained, runs, refused: true as const }
            }
            expect(Exit.isSuccess(result)).toBe(true)
            expect((yield* goals.get(session.id))?.status).toBe("blocked")
            expect((yield* goals.get(session.id))?.createdAt).toBe(goal?.createdAt)
            const runs = yield* runner.tasks.runsFor(worker.id)
            expect(runs).toHaveLength(1)
            expect(runs[0]).toMatchObject({
              id: claim.id,
              sessionID: session.id,
              status: "error",
              goalCreatedAt: goal?.createdAt,
            })
            expect(yield* storage.read(key).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
            const closed = yield* goals.get(session.id)
            const messages = (yield* RayaTaskInbox.make(database).page(worker.id)).messages
            expect(messages.filter((row) => row.source === `recovery:${claim.id}`)).toHaveLength(1)
            yield* runner.resolve(worker.id, claim.id)
            expect(yield* runner.tasks.runsFor(worker.id)).toEqual(runs)
            expect(yield* goals.get(session.id)).toEqual(closed)
            expect((yield* RayaTaskInbox.make(database).page(worker.id)).messages).toEqual(messages)
            return { worker, session, claim, goal: closed, runs, messages, refused: false as const }
          })
          const saved = yield* read.pipe(provideInstance(dir), Effect.provide(profile(dir)))
          yield* Effect.gen(function* () {
            const storage = yield* Storage.Service
            const database = yield* Database.Service
            const sessions = yield* Session.Service
            const runner = RayaTaskRunner.make({
              storage,
              database,
              sessions,
              continuation: (run) => Effect.sync(() => calls.push(run.id)),
            })
            expect(yield* RayaGoal.make({ storage, database, sessions }).get(saved.session.id)).toEqual(saved.goal)
            if (!saved.refused) {
              yield* runner.resolve(saved.worker.id, saved.claim.id)
              expect(yield* runner.tasks.runsFor(saved.worker.id)).toEqual(saved.runs)
              expect((yield* RayaTaskInbox.make(database).page(saved.worker.id)).messages).toEqual(saved.messages)
            }
            if (saved.refused) {
              expect(Exit.isFailure(yield* runner.resolve(saved.worker.id, saved.claim.id).pipe(Effect.exit))).toBe(
                true,
              )
              expect(yield* storage.read(["raya", "agent-claims", hash(saved.worker.id)])).toEqual(saved.claim)
            }
            yield* runner.revive()
            expect(yield* runner.tasks.runsFor(saved.worker.id)).toEqual(saved.runs)
            expect(yield* sessions.messages({ sessionID: saved.session.id })).toEqual([])
            expect(calls).toEqual([])
          }).pipe(provideInstance(dir), Effect.provide(profile(dir)))
        }),
      60_000,
    )
