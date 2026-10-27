import { afterAll, afterEach, expect } from "bun:test"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import type { RayaTask } from "@/kilocode/task"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { project } from "@/kilocode/task/local-inference"
import { createLocalScheduler } from "@/kilocode/provider/local-scheduler"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { remove } from "./cleanup"

const db = path.join(os.tmpdir(), `raya-routine-inference-${crypto.randomUUID()}.sqlite`)
afterAll(async () => {
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map(remove))
}, 30_000)
afterEach(disposeAllInstances)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Session.node,
      SessionProjector.node,
      Storage.node,
      FSUtil.node,
      InstanceStore.node,
      EventV2Bridge.node,
    ]),
    [
      [Database.node, Database.layerFromPath(db)],
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

it.instance(
  "routine observations require the exact live execution and disappear after retirement without saving queue state",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const execution = RayaTaskExecution.make(storage)
      const agent: RayaTask.Agent = {
        id: "agt_observer",
        name: "Researcher",
        role: "Researcher",
        objective: "Read notes",
        capabilities: [],
        memoryScope: "project",
        schedule: { kind: "manual" },
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      }
      const trigger = { kind: "manual" as const }
      const session = yield* sessions.create({
        title: "Routine observer",
        metadata: {
          rayaRoutine: { version: 1, agentID: agent.id, runID: "run_observer", scheduleVersion: 1, trigger },
        },
      })
      const run: RayaTask.Run = {
        id: "run_observer",
        agentID: agent.id,
        at: 1,
        sessionID: session.id,
        status: "running",
        scheduleVersion: 1,
        trigger,
      }
      const active: RayaTask.Agent = {
        ...agent,
        execution: { state: "active", runID: run.id, sessionID: run.sessionID },
      }
      const inbox = RayaTaskInbox.make(yield* Database.Service)
      const runs = new Map([[agent.id, run]])
      const items = yield* inbox.summaries([active], runs)
      expect(items[0]?.state).toBe("running")
      const scheduler = createLocalScheduler()
      const input = {
        items,
        agents: [active],
        runs,
        sessions,
        authorized: execution.authorized,
        current: scheduler.session,
      }
      expect((yield* project(input))[0]?.inference).toBeUndefined()
      yield* execution.enter(
        run,
        Effect.gen(function* () {
          const seen = yield* project(input)
          expect(seen[0]?.inference?.runID).toBe(run.id)
          expect(seen[0]?.inference?.snapshot.sessionID).toBe(session.id)
          expect(seen[0]?.inference?.snapshot.requests).toEqual([])
          expect(
            (yield* project({ ...input, agents: [{ ...agent, execution: { state: "recovery" } }] }))[0]?.inference,
          ).toBeUndefined()
          expect(
            (yield* project({ ...input, runs: new Map([[agent.id, { ...run, status: "complete" }]]) }))[0]?.inference,
          ).toBeUndefined()
          expect(
            (yield* project({
              ...input,
              current: () => ({ ...scheduler.session(session.id), sessionID: SessionID.make("ses_foreign") }),
            }))[0]?.inference,
          ).toBeUndefined()
          const foreign = yield* sessions.create({ title: "Foreign run" })
          expect(
            (yield* project({ ...input, runs: new Map([[agent.id, { ...run, sessionID: foreign.id }]]) }))[0]
              ?.inference,
          ).toBeUndefined()
          expect((yield* inbox.summaries([active], runs))[0]?.inference).toBeUndefined()
          expect((yield* sessions.get(session.id)).metadata).toEqual(session.metadata)
        }),
      )
      yield* execution.finish(run)
      expect((yield* project(input))[0]?.inference).toBeUndefined()
    }),
  30_000,
)
