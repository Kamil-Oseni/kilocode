import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const root = LayerNode.group([
  Bus.node,
  Database.node,
  Session.node,
  SessionProjector.node,
  Storage.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
])
const env = AppNodeBuilder.build(root, [
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
])
const it = testEffect(env.pipe(Layer.provide(RuntimeFlags.layer())))

it.instance("settlement refuses a goal replaced while its actual messages are read", () =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const sessions = yield* Session.Service
    const goals = RayaGoal.make({ storage, sessions })
    for (const status of ["paused", "blocked", "complete"] as const) {
      const session = yield* sessions.create({ title: "Synthetic settlement race" })
      const created = yield* goals.create(session.id, "Original reviewed assignment")
      const key = ["raya", "goal", session.id]
      yield* storage.replace(key, {
        ...created,
        status: "complete",
        activeAt: undefined,
        audit: { summary: "Original completion", verifiedAt: Date.now(), requirements: [] },
      } satisfies RayaGoal.State)
      let changed = false
      const runner = RayaTaskRunner.make({
        storage,
        database,
        sessions: {
          create: sessions.create,
          get: sessions.get,
          children: sessions.children,
          messages: (input) =>
            sessions.messages(input).pipe(
              Effect.tap(() => {
                if (changed) return Effect.void
                changed = true
                return storage
                  .replace(key, {
                    ...created,
                    objective: "Updated reviewed assignment",
                    status,
                    activeAt: undefined,
                    blockedReason: "New reviewed state",
                    audit: { summary: "New review", verifiedAt: Date.now(), requirements: [] },
                  } satisfies RayaGoal.State)
                  .pipe(Effect.orDie)
              }),
            ),
        },
      })
      const agent = yield* runner.tasks.create({
        name: "Synthetic worker",
        objective: "Original reviewed assignment",
        access: "brief",
        memoryScope: "session",
        schedule: { kind: "manual" },
      })
      const run = yield* runner.tasks.record({
        id: `settlement-${status}`,
        agentID: agent.id,
        sessionID: session.id,
        at: created.createdAt,
        status: "running",
      })
      yield* runner.settle(session.id)
      expect((yield* runner.tasks.runsFor(agent.id)).find((row) => row.id === run.id)).toEqual(run)
      expect((yield* runner.tasks.eventsFor(agent.id)).cursor).toBe(1)
      expect((yield* goals.get(session.id))?.status).toBe(status)
      if (status === "paused") continue
      // A fresh observation can settle the new state; stale refusal does not fence it forever.
      yield* runner.settle(session.id)
      const settled = (yield* runner.tasks.runsFor(agent.id)).find((row) => row.id === run.id)
      expect(settled?.status).toBe(status)
      expect(settled?.outcome?.summary).toBe("New reviewed state")
      expect((yield* runner.tasks.eventsFor(agent.id)).cursor).toBe(2)
    }
  }),
)
