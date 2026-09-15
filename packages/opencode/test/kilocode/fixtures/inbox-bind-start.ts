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
import { RayaTaskInbox } from "../../../src/kilocode/task/inbox"
import { RayaTaskSnapshot } from "../../../src/kilocode/task/snapshot"
import { Git } from "../../../src/git"

const file = process.argv[2]
const dir = process.argv[3]
const agentID = process.argv[4]
const mode = process.argv[5]
if (!file || !dir || !agentID || (mode !== "before" && mode !== "after" && mode !== "owned"))
  throw new Error("Expected database, storage, agent and before/after/owned mode")

await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const storage = yield* Storage.Service
    const tasks = RayaTask.make({ database, storage })
    const inbox = RayaTaskInbox.make(database)
    const agent = yield* tasks.get(agentID)
    const prior = SessionID.make(`ses_bind_old_${mode}`)
    const next = SessionID.make(`ses_bind_next_${mode}`)
    const source = `user_bind_${mode}`
    const trigger = { kind: "manual" as const }
    return yield* claim(
      storage,
      agentID,
      Effect.succeed({ trigger }),
      (_, owner) =>
        Effect.gen(function* () {
          const project = ProjectV2.ID.make(`project_bind_${mode}`)
          const at = Date.now()
          const metadata = {
            rayaRoutine: {
              version: 1,
              agentID,
              runID: owner.id,
              scheduleVersion: agent.scheduleVersion ?? 1,
              trigger,
            },
          }
          yield* RayaTaskSnapshot.make({ storage }).save({
            version: 1,
            runID: owner.id,
            agentID,
            at: owner.at,
            definition: agent,
            objective: "Continue safely",
          })
          yield* database.db.run(
            sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${project}, ${dir}, ${JSON.stringify([])}, ${at}, ${at})`,
          )
          yield* database.db.run(
            sql`INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated) VALUES (${next}, ${project}, 'routine', ${dir}, ${agent.name}, 'test', ${JSON.stringify(metadata)}, ${at}, ${at})`,
          )
          yield* owner.link(next)
          yield* storage.write(["raya", "goal", next], {
            objective: "Continue safely",
            status: "active",
            createdAt: at,
            updatedAt: at,
            usage: { turns: 0, continuations: 0, toolCalls: 0 },
            progress: [],
          })
          yield* tasks.record({
            id: owner.id,
            agentID,
            sessionID: next,
            at: owner.at,
            scheduleVersion: agent.scheduleVersion ?? 1,
            trigger,
            status: "running",
          })
          if (mode === "after") yield* inbox.move(agentID, source, prior, next)
          if (mode === "owned") yield* inbox.delivery(prior, "msg_bind_owned")
          return process.exit(21)
        }),
      (value) => value.trigger,
      undefined,
      undefined,
      { source, sessionID: prior },
    )
  }).pipe(
    Effect.provide(Storage.layerFromDir(dir)),
    Effect.provide(Database.layerFromPath(file)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
    Effect.scoped,
  ),
)
