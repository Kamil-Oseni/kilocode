import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { scheduler } from "@/kilocode/task/scheduler"

const directory = process.argv[2]
const result = process.argv[3]
if (!directory || !result) throw new Error("Expected persisted directory and result path")

await Effect.runPromise(
  Effect.gen(function* () {
    const input = { storage: yield* Storage.Service, database: yield* Database.Service }
    const tasks = RayaTask.make(input)
    const schedule = scheduler(input)
    const at = Date.now() + 60_000
    const agent = yield* tasks.create({
      name: "Stopped scheduled owner",
      objective: "Retain exact identity",
      schedule: { kind: "once", at },
    })
    const trigger = yield* schedule.prepare(agent.id, at)
    if (!trigger) throw new Error("Expected persisted occurrence")
    const id = crypto.randomUUID()
    const sid = SessionID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
    yield* schedule.reserve(trigger, id)
    yield* schedule.link(trigger, id, sid)
    const run = yield* tasks.record({
      id,
      agentID: agent.id,
      at,
      sessionID: sid,
      status: "blocked",
      blockedReason: "waiting on you",
      scheduleVersion: 1,
      trigger,
    })
    const execution = RayaTaskExecution.make(input.storage)
    yield* execution.enter(run, Effect.fail("uncertain outcome")).pipe(Effect.exit)
    const record = yield* execution.receipt(run)
    if (!record) throw new Error("Expected retained execution")
    const ctx = {
      intent: "reviewed-reply",
      source: "user-reply",
      execution: createHash("sha256").update(record.token).digest("hex"),
    }
    yield* Effect.promise(() => Bun.write(result, JSON.stringify({ run, ctx, record })))
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Storage.layerFromDir(path.join(directory, "storage")),
        Database.layerFromPath(path.join(directory, "queue.sqlite")),
      ),
    ),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ),
)
