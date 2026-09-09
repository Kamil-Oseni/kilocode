import { describe, expect } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

describe("routine persistence", () => {
  it.live("legacy one-shot history and revised consumption survive reopening storage", () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const id = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const agent = yield* tasks.create({ name: "Legacy", objective: "Work", schedule: { kind: "once", at: 1000 } })
        yield* storage.replace(
          ["raya", "agent"],
          [{ ...agent, scheduleVersion: undefined, scheduleUpdatedAt: undefined }],
        )
        yield* storage.replace(
          ["raya", "agent-runs", agent.id],
          [{ id: "legacy", agentID: agent.id, at: 1000, sessionID: SessionID.make("ses_legacy"), status: "complete" }],
        )
        return agent.id
      }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        expect(yield* tasks.ready(2000)).toEqual([])
        const changed = yield* tasks.update(id, { schedule: { kind: "once", at: 2000 }, expectedScheduleVersion: 1 })
        expect(changed.scheduleVersion).toBe(2)
        expect((yield* tasks.ready(2000)).map((item) => item.id)).toEqual([id])
        yield* tasks.record({
          id: "revised",
          agentID: id,
          at: 2000,
          sessionID: SessionID.make("ses_revised"),
          status: "complete",
          scheduleVersion: 2,
          trigger: { kind: "timer", id: "revised-occurrence", scheduledAt: 2000, observedAt: 2500 },
        })
      }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        expect((yield* tasks.get(id)).scheduleVersion).toBe(2)
        expect(yield* tasks.ready(3000)).toEqual([])
        expect((yield* tasks.runsFor(id)).map((run) => run.scheduleVersion)).toEqual([undefined, 2])
        expect((yield* tasks.runsFor(id)).map((run) => run.trigger)).toEqual([
          undefined,
          { kind: "timer", id: "revised-occurrence", scheduledAt: 2000, observedAt: 2500 },
        ])
      }).pipe(Effect.provide(Storage.layerFromDir(directory)))
    }),
  )

  it.live("invalid legacy calendars do not prevent other routines from polling or appearing", () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const at = Date.now()
        const valid = yield* tasks.create({ name: "Ready", objective: "Work", schedule: { kind: "once", at } })
        const schedules: RayaTask.Schedule[] = [
          { kind: "cron", expr: "0 25 * * *", tz: "UTC" },
          { kind: "cron", expr: "* * * * *", tz: "Invalid/Timezone" },
          { kind: "cron", expr: "0 0 30 2 *", tz: "UTC" },
        ]
        const legacy = schedules.map((schedule, index) => ({
          ...valid,
          id: `legacy-${index}`,
          schedule,
          note: "Keep this note.",
          nextRun: 123,
        }))
        const prior = [...legacy, valid]
        yield* storage.replace(["raya", "agent"], prior)
        expect((yield* tasks.ready(at)).map((item) => item.id)).toEqual([valid.id])
        const preview = yield* tasks.preview(at)
        expect(preview).toHaveLength(4)
        for (const item of preview.slice(0, 3)) {
          expect(item.nextRun).toBeUndefined()
          expect(item.note).toContain("Schedule needs attention:")
          expect(item.note).toContain("Keep this note.")
        }
        expect(preview[3].nextRun).toBe(at)
        expect(yield* tasks.list()).toEqual(prior)
        yield* tasks.update(legacy[0].id, { schedule: { kind: "once", at } })
        expect((yield* tasks.preview(at))[0].note).toBe("Keep this note.")
        expect((yield* tasks.ready(at)).map((item) => item.id)).toEqual([legacy[0].id, valid.id])
      }).pipe(Effect.provide(Storage.layerFromDir(directory)))
    }),
  )

  it.live(
    "rejects an old callback after waiting and returning to the same running content",
    () =>
      Effect.gen(function* () {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const expected = yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const tasks = RayaTask.make({ storage })
          const agent = yield* tasks.create({ name: "Legacy", objective: "Work", schedule: { kind: "manual" } })
          const run: RayaTask.Run = {
            id: "legacy",
            agentID: agent.id,
            sessionID: SessionID.make("ses_legacy"),
            at: Date.now(),
            status: "running",
          }
          yield* storage.replace(["raya", "agent-runs", agent.id], [run])
          return (yield* tasks.runsFor(agent.id))[0]
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          expect(
            yield* tasks.transition(expected, { ...expected, status: "blocked", blockedReason: "waiting on you" }),
          ).toBe(true)
          const waiting = (yield* tasks.runsFor(expected.agentID))[0]
          expect(yield* tasks.transition(waiting, { ...waiting, status: "running", blockedReason: undefined })).toBe(
            true,
          )
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          expect(yield* tasks.transition(expected, { ...expected, status: "error" })).toBe(false)
          expect((yield* tasks.runsFor(expected.agentID))[0]?.status).toBe("running")
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      }),
    30_000,
  )

  it.live(
    "only one writer can transition the same stored run snapshot",
    () =>
      Effect.gen(function* () {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const expected = yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          const agent = yield* tasks.create({ name: "Routine", objective: "Work", schedule: { kind: "manual" } })
          yield* tasks.record({
            id: "run",
            agentID: agent.id,
            sessionID: SessionID.make("ses_transition"),
            at: Date.now(),
            status: "running",
          })
          return (yield* tasks.runsFor(agent.id))[0]
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        const results = yield* Effect.all(
          Array.from({ length: 3 }, (_, index) =>
            Effect.gen(function* () {
              const tasks = RayaTask.make({ storage: yield* Storage.Service })
              return yield* tasks.transition(expected, {
                ...expected,
                status: "complete",
                outcome: { kind: "notify", summary: String(index), cost: 0 },
              })
            }).pipe(Effect.provide(Storage.layerFromDir(directory))),
          ),
          { concurrency: 3 },
        )
        expect(results.filter(Boolean)).toHaveLength(1)
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          const current = (yield* tasks.runsFor(expected.agentID))[0]
          expect(current.outcome?.summary).toBe(String(results.indexOf(true)))
          expect(
            yield* tasks.transition(expected, { ...expected, status: "blocked", blockedReason: "waiting on you" }),
          ).toBe(false)
          expect(yield* tasks.transition(current, { ...current, status: "running" })).toBe(false)
          expect((yield* tasks.runsFor(expected.agentID))[0]).toEqual(current)
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      }),
    30_000,
  )

  it.live(
    "separate processes preserve updates after a mutation owner exits abruptly",
    () =>
      Effect.gen(function* () {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const seed = yield* Effect.gen(function* () {
          return yield* RayaTask.make({ storage: yield* Storage.Service }).create({
            name: "Seed",
            objective: "Work",
            schedule: { kind: "manual" },
          })
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        const fixture = fileURLToPath(new URL("./fixtures/task-write.ts", import.meta.url))
        const crash = yield* spawner.exitCode(
          ChildProcess.make(process.execPath, [fixture, directory, "crash", seed.id], {
            stdin: "ignore",
            detached: false,
          }),
        )
        expect(Number(crash)).toBe(21)
        const results = yield* Effect.all(
          Array.from({ length: 3 }, (_, owner) =>
            spawner.exitCode(
              ChildProcess.make(process.execPath, [fixture, directory, String(owner), seed.id], {
                stdin: "ignore",
                stderr: "inherit",
                detached: false,
              }),
            ),
          ),
          { concurrency: 3 },
        )
        expect(results.every((code) => code === 0)).toBe(true)
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          expect(yield* tasks.list()).toHaveLength(10)
          expect((yield* tasks.runsFor(seed.id)).map((run) => run.id).sort()).toEqual(
            Array.from({ length: 3 }, (_, owner) => Array.from({ length: 3 }, (_, index) => `${owner}-${index}`))
              .flat()
              .sort(),
          )
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      }),
    30_000,
  )

  it.live(
    "independent writers preserve every created routine and run",
    () =>
      Effect.gen(function* () {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const seed = yield* Effect.gen(function* () {
          return yield* RayaTask.make({ storage: yield* Storage.Service }).create({
            name: "Seed",
            objective: "Work",
            schedule: { kind: "manual" },
          })
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        const created = yield* Effect.all(
          Array.from({ length: 12 }, (_, index) =>
            Effect.gen(function* () {
              return yield* RayaTask.make({ storage: yield* Storage.Service }).create({
                name: `Routine ${index}`,
                objective: "Work",
                schedule: { kind: "manual" },
              })
            }).pipe(Effect.provide(Storage.layerFromDir(directory))),
          ),
          { concurrency: 12 },
        )
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          expect((yield* tasks.list()).map((item) => item.id).sort()).toEqual(
            [seed.id, ...created.map((item) => item.id)].sort(),
          )
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        yield* Effect.all(
          Array.from({ length: 12 }, (_, index) =>
            Effect.gen(function* () {
              const tasks = RayaTask.make({ storage: yield* Storage.Service })
              yield* tasks.record({
                id: `run-${index}`,
                agentID: seed.id,
                sessionID: SessionID.make(`ses_${index}`),
                at: index,
                status: "complete",
              })
              yield* tasks.append(seed.id, `note-${index}`)
            }).pipe(Effect.provide(Storage.layerFromDir(directory))),
          ),
          { concurrency: 12 },
        )
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          expect((yield* tasks.runsFor(seed.id)).map((run) => run.id).sort()).toEqual(
            Array.from({ length: 12 }, (_, index) => `run-${index}`).sort(),
          )
          expect((yield* tasks.recall(seed.id)).split("\n\n").sort()).toEqual(
            Array.from({ length: 12 }, (_, index) => `note-${index}`).sort(),
          )
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      }),
    30_000,
  )

  it.live(
    "independent readers see complete roster revisions during publication",
    () =>
      Effect.gen(function* () {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const size = 256 * 1024
        const agent = yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          return yield* tasks.create({ name: "A", objective: "A".repeat(size), schedule: { kind: "manual" } })
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        const writer = Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          for (let index = 0; index < 20; index++) {
            const name = index % 2 ? "A" : "B"
            yield* tasks.update(agent.id, { name, objective: name.repeat(size) })
          }
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        const reader = Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          for (let index = 0; index < 40; index++) {
            const current = yield* tasks.get(agent.id)
            expect(current.objective).toBe(current.name.repeat(size))
          }
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
        yield* Effect.all([writer, reader], { concurrency: 2 })
      }),
    30_000,
  )

  it.live(
    "failed publication preserves the prior roster, history and memory",
    () =>
      Effect.gen(function* () {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const fs = yield* FSUtil.Service
        const layer = Storage.layerFromDir(directory)
        const original = yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          const agent = yield* tasks.create({ name: "Original", objective: "Work", schedule: { kind: "manual" } })
          const run: RayaTask.Run = {
            id: "original",
            agentID: agent.id,
            at: Date.now(),
            sessionID: SessionID.make("ses_original"),
            status: "running",
          }
          const stored = yield* tasks.record(run)
          yield* tasks.remember(agent.id, "Original memory")
          return { agent, run: stored }
        }).pipe(Effect.provide(layer))
        const faulty = Storage.layerFromDir(directory).pipe(
          Layer.provide(
            Layer.succeed(FSUtil.Service, {
              ...fs,
              rename: () => Effect.die("publication rename failed"),
            }),
          ),
        )
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          expect(
            Exit.isFailure(yield* tasks.update(original.agent.id, { name: "Replacement" }).pipe(Effect.exit)),
          ).toBe(true)
          expect(Exit.isFailure(yield* tasks.record({ ...original.run, status: "complete" }).pipe(Effect.exit))).toBe(
            true,
          )
          expect(Exit.isFailure(yield* tasks.remember(original.agent.id, "Replacement memory").pipe(Effect.exit))).toBe(
            true,
          )
        }).pipe(Effect.provide(faulty))
        yield* Effect.gen(function* () {
          const tasks = RayaTask.make({ storage: yield* Storage.Service })
          expect(yield* tasks.get(original.agent.id)).toEqual(original.agent)
          expect(yield* tasks.runsFor(original.agent.id)).toEqual([original.run])
          expect(yield* tasks.recall(original.agent.id)).toBe("Original memory")
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      }),
    30_000,
  )
})
