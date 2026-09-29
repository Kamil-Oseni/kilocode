import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { references } from "@/kilocode/goal/references"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

describe("routine event journal", () => {
  it.live("commits redacted events with run revisions and replays them after reopening", () =>
    Effect.gen(function* () {
      const dir = path.join(yield* tmpdirScoped(), "storage")
      const id = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const agent = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
        yield* storage.replace(
          ["raya", "agent-runs", agent.id],
          [{ id: "legacy", agentID: agent.id, at: 1, sessionID: SessionID.make("ses_legacy"), status: "complete" }],
        )
        expect((yield* tasks.eventsFor(agent.id)).cursor).toBe(0)
        const run = yield* tasks.record({
          id: "run",
          agentID: agent.id,
          sessionID: SessionID.make("ses_journal"),
          at: 2,
          status: "running",
        })
        const secret = "private model output and credential"
        expect(
          yield* tasks.transition(run, {
            ...run,
            status: "complete",
            outcome: { kind: "notify", summary: secret, cost: 0 },
          }),
        ).toBe(true)
        const saved = yield* storage.read<RayaTask.History>(["raya", "agent-runs", agent.id])
        expect(Array.isArray(saved)).toBe(false)
        expect(saved.cursor).toBe(2)
        expect(saved.events.map((event) => [event.sequence, event.stateRevision, event.status])).toEqual([
          [1, 1, "running"],
          [2, 2, "complete"],
        ])
        expect(JSON.stringify(saved.events)).not.toContain(secret)
        expect(yield* references(storage)).toContain(SessionID.make("ses_journal"))
        return agent.id
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
      yield* Effect.gen(function* () {
        const tasks = RayaTask.make({ storage: yield* Storage.Service })
        const page = yield* tasks.eventsFor(id, 1)
        expect(page.cursor).toBe(2)
        expect(page.events.map((event) => event.id)).toEqual([`${id}:2`])
        expect(page.runs.find((run) => run.id === "legacy")?.status).toBe("complete")
        expect(page.runs.find((run) => run.id === "run")?.revision).toBe(2)
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }),
  )

  it.live("leaves run and cursor unchanged when the atomic replacement fails", () =>
    Effect.gen(function* () {
      const dir = path.join(yield* tmpdirScoped(), "storage")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const agent = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
        const run = yield* tasks.record({
          id: "run",
          agentID: agent.id,
          sessionID: SessionID.make("ses_journal"),
          at: 1,
          status: "running",
        })
        const failing = RayaTask.make({
          storage: {
            ...storage,
            replace: (key, value) =>
              key[0] === "raya" && key[1] === "agent-runs" ? Effect.die("write failed") : storage.replace(key, value),
          },
        })
        const failed = yield* Effect.exit(failing.transition(run, { ...run, status: "complete" }))
        expect(Exit.isFailure(failed)).toBe(true)
        const page = yield* tasks.eventsFor(agent.id)
        expect(page.cursor).toBe(1)
        expect(page.events).toHaveLength(1)
        expect(page.runs.find((item) => item.id === run.id)?.status).toBe("running")
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }),
  )

  it.live("signals an expired cursor while preserving the terminal snapshot", () =>
    Effect.gen(function* () {
      const dir = path.join(yield* tmpdirScoped(), "storage")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const agent = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
        const run = yield* tasks.record({
          id: "run",
          agentID: agent.id,
          sessionID: SessionID.make("ses_journal"),
          at: 1,
          status: "complete",
        })
        const saved = yield* storage.read<RayaTask.History>(["raya", "agent-runs", agent.id])
        yield* storage.replace(["raya", "agent-runs", agent.id], {
          ...saved,
          cursor: 3,
          events: [{ ...saved.events[0], id: `${agent.id}:3`, sequence: 3 }],
        })
        const stale = yield* Effect.exit(tasks.eventsFor(agent.id, 1))
        expect(Exit.isFailure(stale)).toBe(true)
        const current = yield* tasks.eventsFor(agent.id, 2)
        expect(current.events.map((event) => event.sequence)).toEqual([3])
        expect(current.runs.find((item) => item.id === run.id)?.status).toBe("complete")
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }),
  )

  it.live("caps retained event bytes and requires a snapshot after pruning", () =>
    Effect.gen(function* () {
      const dir = path.join(yield* tmpdirScoped(), "storage")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const agent = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
        yield* tasks.record({
          id: "terminal",
          agentID: agent.id,
          sessionID: SessionID.make("ses_journal"),
          at: 1,
          status: "complete",
        })
        const saved = yield* storage.read<RayaTask.History>(["raya", "agent-runs", agent.id])
        const events = Array.from({ length: 80 }, (_, index) => ({
          ...saved.events[0],
          id: `${agent.id}:${index + 1}`,
          sequence: index + 1,
          runID: "x".repeat(6000),
        }))
        yield* storage.replace(["raya", "agent-runs", agent.id], { ...saved, cursor: 80, events })
        yield* tasks.record({
          id: "y".repeat(40_000),
          agentID: agent.id,
          sessionID: SessionID.make("ses_next"),
          at: 2,
          status: "running",
        })
        const page = yield* storage.read<RayaTask.History>(["raya", "agent-runs", agent.id])
        expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(512 * 1024)
        expect(page.cursor).toBe(81)
        expect(page.events[0].sequence).toBeGreaterThan(1)
        expect(Exit.isFailure(yield* Effect.exit(tasks.eventsFor(agent.id, 0)))).toBe(true)
        expect(page.runs.find((run) => run.id === "terminal")?.status).toBe("complete")
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }),
  )

  it.live("fails closed on corrupt v1 identities, ordering, and retention bounds", () =>
    Effect.gen(function* () {
      const dir = path.join(yield* tmpdirScoped(), "storage")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const agent = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
        for (const index of [1, 2])
          yield* tasks.record({
            id: `run-${index}`,
            agentID: agent.id,
            sessionID: SessionID.make(`ses_${index}`),
            at: index,
            status: "complete",
          })
        const key = ["raya", "agent-runs", agent.id]
        const saved = yield* storage.read<RayaTask.History>(key)
        const first = saved.events[0]!
        const second = saved.events[1]!
        const corrupt: RayaTask.History[] = [
          { ...saved, events: [{ ...first, stream: "other" }, second] },
          { ...saved, events: [{ ...first, agentID: "other" }, second] },
          { ...saved, events: [{ ...first, id: "other" }, second] },
          { ...saved, events: [{ ...first, sequence: 0 }, second] },
          { ...saved, cursor: 3 },
          { ...saved, events: [{ ...first, runID: "x".repeat(512 * 1024) }, second] },
          {
            ...saved,
            cursor: 1025,
            events: Array.from({ length: 1025 }, (_, index) => ({
              ...first,
              sequence: index + 1,
              id: `${agent.id}:${index + 1}`,
            })),
          },
        ]
        for (const value of corrupt) {
          yield* storage.replace(key, value)
          expect(Exit.isFailure(yield* Effect.exit(tasks.eventsFor(agent.id)))).toBe(true)
        }
        yield* storage.replace(key, saved)
        expect((yield* tasks.eventsFor(agent.id)).events).toHaveLength(2)
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }),
  )
})
