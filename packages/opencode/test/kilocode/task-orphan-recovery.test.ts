import path from "node:path"
import { createHash } from "node:crypto"
import { expect } from "bun:test"
import { Effect, Exit, Schema, Stream } from "effect"
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
import { durable, stopped } from "@/kilocode/task/owner"
import { Record as Claim } from "@/kilocode/task/recovery"
import { record as Identity } from "@/kilocode/task/continuation"
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

for (const kind of ["manual", "event"] as const)
  for (const fault of [
    "none",
    "foreign",
    "ambiguous",
    "trigger",
    "snapshot",
    "fork",
    "legacy",
    "live",
    "foreign-owner",
    "unknown-owner",
    "goal",
    "race",
  ] as const)
    it.live(
      `${kind} unlinked orphan recovery ${fault} preserves original session without inventing a goal`,
      () =>
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          const child = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
            ChildProcess.make(process.execPath, [
              path.join(import.meta.dir, "fixtures", "task-orphan-start.ts"),
              dir,
              kind,
              "unlinked",
            ]),
          )
          const joined = yield* Effect.all([
            child.exitCode,
            Stream.runCollect(child.stdout),
            Stream.runCollect(child.stderr),
          ])
          if (joined[0] !== 23)
            throw new Error(
              `Original pre-link startup exited ${joined[0]}: ${Buffer.concat([...joined[2]])
                .toString()
                .slice(-16000)}`,
            )
          expect(Number(joined[0])).toBe(23)
          const calls: string[] = []
          const saved = yield* Effect.gen(function* () {
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
                      const row = (yield* sessions.list({ kind: "all" }))[0]
                      if (!row) throw new Error("Original physical session absent during history restore")
                      yield* goals.create(row.id, "USER_GOAL_MUST_SURVIVE").pipe(Effect.orDie)
                    }),
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
            const original = yield* storage.read(key).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Claim)))
            expect(original.phase).toBe("claimed")
            expect(original.sessionID).toBeUndefined()
            expect(stopped(original.owner)).toBe(true)
            const rows = yield* sessions.list({ kind: "all" })
            expect(rows).toHaveLength(1)
            const session = rows[0]
            const identity = yield* Schema.decodeUnknownEffect(Identity)(session.metadata?.rayaRoutine)
            expect(identity.agentID).toBe(worker.id)
            expect(identity.runID).toBe(original.id)
            expect(original.trigger).toEqual(identity.trigger)
            const snapshot = yield* storage.read<Record<string, unknown>>(["raya", "agent-starts", hash(original.id)])
            expect(snapshot.sessionID).toBe(session.id)
            expect(yield* goals.get(session.id)).toBeUndefined()
            expect(yield* runner.tasks.runsFor(worker.id)).toEqual([])
            if (fault === "foreign" || fault === "trigger")
              yield* database.db
                .update(SessionTable)
                .set({
                  metadata: {
                    rayaRoutine:
                      fault === "foreign"
                        ? { ...identity, agentID: "foreign" }
                        : { ...identity, trigger: { kind: "event", source: "wrong-event", receivedAt: Date.now() } },
                  },
                })
                .where(eq(SessionTable.id, session.id))
                .run()
            if (fault === "ambiguous")
              yield* sessions.create({ title: "Ambiguous persisted session", metadata: session.metadata })
            if (fault === "fork") {
              const fork = yield* sessions.fork({ sessionID: session.id })
              expect(fork.id).not.toBe(session.id)
              expect(fork.metadata?.rayaRoutine).toEqual(session.metadata?.rayaRoutine)
              yield* sessions.setMetadata({ sessionID: session.id, metadata: {} })
            }
            if (fault === "snapshot") {
              const path = ["raya", "agent-starts", hash(original.id)]
              const snapshot = yield* storage.read<Record<string, unknown>>(path)
              yield* storage.replace(path, { ...snapshot, at: Number(snapshot.at) + 1 })
            }
            if (fault === "legacy") {
              const previous = { ...snapshot }
              delete previous.sessionID
              yield* storage.replace(["raya", "agent-starts", hash(original.id)], previous)
            }
            if (fault === "live") yield* storage.replace(key, { ...original, owner: durable() })
            if (fault === "foreign-owner")
              yield* storage.replace(key, { ...original, owner: { ...original.owner, host: "foreign-host" } })
            if (fault === "unknown-owner")
              yield* storage.replace(key, { ...original, owner: { ...durable(), birth: "unqualified" } })
            if (fault === "goal") yield* goals.create(session.id, "USER_GOAL_MUST_SURVIVE")
            const claim = yield* storage.read(key)
            const before = yield* goals.get(session.id)
            const result = yield* runner.resolve(worker.id, original.id).pipe(Effect.exit)
            const goal = yield* goals.get(session.id)
            const runs = yield* runner.tasks.runsFor(worker.id)
            const messages = (yield* RayaTaskInbox.make(database).page(worker.id)).messages
            if (fault !== "none") {
              expect(Exit.isFailure(result)).toBe(true)
              expect(yield* storage.read(key)).toEqual(claim)
              expect(runs).toHaveLength(fault === "race" ? 1 : 0)
              expect(messages).toEqual([])
              if (fault === "race") {
                expect(replaced.done).toBe(true)
                expect(goal?.status).toBe("active")
                expect(goal?.objective).toBe("USER_GOAL_MUST_SURVIVE")
                expect(goal?.routine).toBeUndefined()
              }
              if (fault !== "race") expect(goal).toEqual(before)
              expect(Exit.isFailure(yield* runner.resolve(worker.id, original.id).pipe(Effect.exit))).toBe(true)
              expect(yield* storage.read(key)).toEqual(claim)
              expect(yield* goals.get(session.id)).toEqual(goal)
            }
            if (fault === "none") {
              expect(Exit.isSuccess(result)).toBe(true)
              if (Exit.isSuccess(result))
                expect(result.value).toMatchObject({ agentID: worker.id, runID: original.id, sessionID: session.id })
              expect(goal).toBeUndefined()
              expect(runs).toHaveLength(1)
              expect(runs[0]).toMatchObject({
                id: original.id,
                agentID: worker.id,
                sessionID: session.id,
                at: original.at,
                scheduleVersion: identity.scheduleVersion,
                trigger: identity.trigger,
                status: "error",
              })
              expect(runs[0].goalCreatedAt).toBeUndefined()
              expect(messages.filter((row) => row.source === `recovery:${original.id}`)).toHaveLength(1)
              expect(yield* storage.read(key).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
              yield* runner.resolve(worker.id, original.id)
            }
            expect(yield* runner.tasks.runsFor(worker.id)).toEqual(runs)
            expect((yield* RayaTaskInbox.make(database).page(worker.id)).messages).toEqual(messages)
            expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
            expect(calls).toEqual([])
            return { worker, session, original, claim, goal, runs, messages }
          }).pipe(provideInstance(dir), Effect.provide(profile(dir)))
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
            if (fault === "none") yield* runner.resolve(saved.worker.id, saved.original.id)
            if (fault !== "none") {
              expect(Exit.isFailure(yield* runner.resolve(saved.worker.id, saved.original.id).pipe(Effect.exit))).toBe(
                true,
              )
              expect(yield* storage.read(["raya", "agent-claims", hash(saved.worker.id)])).toEqual(saved.claim)
            }
            yield* runner.revive()
            expect(yield* RayaGoal.make({ storage, database, sessions }).get(saved.session.id)).toEqual(saved.goal)
            expect(yield* runner.tasks.runsFor(saved.worker.id)).toEqual(saved.runs)
            expect((yield* RayaTaskInbox.make(database).page(saved.worker.id)).messages).toEqual(saved.messages)
            expect(yield* sessions.messages({ sessionID: saved.session.id })).toEqual([])
            expect(calls).toEqual([])
          }).pipe(provideInstance(dir), Effect.provide(profile(dir)))
        }),
      60_000,
    )
