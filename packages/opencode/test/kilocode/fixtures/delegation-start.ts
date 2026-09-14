import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { sql } from "drizzle-orm"
import { SessionID } from "../../../src/session/schema"
import { Storage } from "../../../src/storage/storage"
import { RayaTask } from "../../../src/kilocode/task"
import { claim } from "../../../src/kilocode/task/claim"
import { RayaTaskDelegation } from "../../../src/kilocode/task/delegation"
import { RayaTaskSnapshot } from "../../../src/kilocode/task/snapshot"
import { Git } from "../../../src/git"

const file = process.argv[2]
const dir = process.argv[3]
const recipient = process.argv[4]
const mode = process.argv[5]
if (!file || !dir || !recipient || (mode !== "session" && mode !== "history"))
  throw new Error("Expected database, storage, recipient and session/history mode")

await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const storage = yield* Storage.Service
    const tasks = RayaTask.make({ database, storage })
    const agent = yield* tasks.get(recipient)
    const row = yield* RayaTaskDelegation.make(database).take(recipient)
    if (!row?.childRunID) return yield* Effect.die(new Error("Expected accepted delegation"))
    const trigger = { kind: "manual" as const }
    return yield* claim(
      storage,
      recipient,
      Effect.succeed({ trigger }),
      (_, owner) =>
        Effect.gen(function* () {
          const sid = SessionID.make(`ses_process_${mode}`)
          const project = ProjectV2.ID.make(`project_process_${mode}`)
          const at = Date.now()
          const metadata = {
            rayaRoutine: {
              version: 1,
              agentID: recipient,
              runID: owner.id,
              scheduleVersion: agent.scheduleVersion ?? 1,
              trigger,
              delegationID: row.id,
            },
          }
          yield* RayaTaskSnapshot.make({ storage }).save({
            version: 1,
            runID: owner.id,
            agentID: recipient,
            at: owner.at,
            definition: agent,
            objective: row.objective,
          })
          yield* database.db.run(
            sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${project}, ${dir}, ${JSON.stringify([])}, ${at}, ${at})`,
          )
          yield* database.db.run(
            sql`INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated) VALUES (${sid}, ${project}, 'routine', ${dir}, ${agent.name}, 'test', ${JSON.stringify(metadata)}, ${at}, ${at})`,
          )
          yield* owner.link(sid)
          yield* storage.write(["raya", "goal", sid], {
            objective: row.objective,
            status: "active",
            createdAt: at,
            updatedAt: at,
            usage: { turns: 0, continuations: 0, toolCalls: 0 },
            progress: [],
          })
          if (mode === "history")
            yield* tasks.record({
              id: owner.id,
              agentID: recipient,
              sessionID: sid,
              at: owner.at,
              scheduleVersion: agent.scheduleVersion ?? 1,
              trigger,
              status: "running",
            })
          return process.exit(21)
        }),
      (value) => value.trigger,
      undefined,
      undefined,
      { runID: row.childRunID, delegationID: row.id },
    )
  }).pipe(
    Effect.provide(Storage.layerFromDir(dir)),
    Effect.provide(Database.layerFromPath(file)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
    Effect.scoped,
  ),
)
