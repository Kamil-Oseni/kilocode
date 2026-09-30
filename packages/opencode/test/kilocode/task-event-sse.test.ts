import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer, Queue, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { EventPaths } from "@/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const it = testEffect(
  Layer.mergeAll(httpApiLayer, LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
)
const storage = (directory: string) => Storage.layerFromDir(path.join(directory, "storage"))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("routine live event hint", () => {
  it.instance(
    "sends only a persisted redacted run event through the instance SSE stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const response = yield* requestInDirectory(EventPaths.event, directory)
        expect(response.status).toBe(200)
        const queue = yield* Queue.unbounded<unknown>()
        yield* response.stream.pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.runForEach((frame) => Effect.sync(() => Queue.offerUnsafe(queue, JSON.parse(frame.data) as unknown))),
          Effect.forkScoped,
        )
        expect(yield* Queue.take(queue)).toMatchObject({ type: "server.connected" })
        const secret = "private model output and credential"
        const event = yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const tasks = RayaTask.make({ storage })
          const agent = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
          yield* tasks.record({
            id: "run",
            agentID: agent.id,
            sessionID: SessionID.make("ses_live_journal"),
            at: 1,
            status: "running",
            outcome: { kind: "notify", summary: secret, cost: 0 },
          })
          return (yield* tasks.eventsFor(agent.id)).events[0]
        }).pipe(Effect.provide(storage(directory)))
        const frame = (yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"))) as {
          type: string
          properties: { event: RayaTask.Event }
        }
        expect(frame.type).toBe(RayaTask.Changed.type)
        expect(frame.properties.event).toEqual(event)
        expect(JSON.stringify(frame)).not.toContain(secret)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "retains the saved transition when an SSE listener throws",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        let count = 0
        const listener = () => {
          count++
          throw new Error("listener failed")
        }
        GlobalBus.on("event", listener)
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const tasks = RayaTask.make({ storage })
          const agent = yield* tasks.create({ name: "Worker", objective: "Work", schedule: { kind: "manual" } })
          const run = yield* tasks.record({
            id: "run",
            agentID: agent.id,
            sessionID: SessionID.make("ses_live_journal"),
            at: 1,
            status: "running",
          })
          expect((yield* tasks.eventsFor(agent.id)).events[0]?.runID).toBe(run.id)
          expect(count).toBe(1)
          const failing = RayaTask.make({
            storage: {
              ...storage,
              replace: (key, value) =>
                key[0] === "raya" && key[1] === "agent-runs" ? Effect.die("write failed") : storage.replace(key, value),
            },
          })
          expect(Exit.isFailure(yield* Effect.exit(failing.transition(run, { ...run, status: "complete" })))).toBe(true)
          expect(count).toBe(1)
          expect((yield* tasks.eventsFor(agent.id)).cursor).toBe(1)
        }).pipe(
          Effect.provide(storage(directory)),
          Effect.ensuring(Effect.sync(() => GlobalBus.off("event", listener))),
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )
})
