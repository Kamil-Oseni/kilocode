import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskWait } from "@/kilocode/task/wait-notice"
import { tmpdir } from "../../fixture/fixture"

function fixture(root: string) {
  const layer = Storage.layerWithDatabase(path.join(root, "storage")).pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(root, "wait.sqlite"))),
    Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  )
  const run = <A, E>(
    body: (data: {
      database: Database.Interface
      storage: Storage.Interface
      tasks: ReturnType<typeof RayaTask.make>
      inbox: ReturnType<typeof RayaTaskInbox.make>
      queue: ReturnType<typeof RayaTaskQueue.make>
    }) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const storage = yield* Storage.Service
        return yield* body({
          database,
          storage,
          tasks: RayaTask.make({ storage, database }),
          inbox: RayaTaskInbox.make(database),
          queue: RayaTaskQueue.make(database),
        })
      }).pipe(Effect.provide(layer)),
    )
  return { run }
}

test("a long-wait notice persists once across reopening and retries report projection without another inbox message", async () => {
  await using directory = await tmpdir()
  const { run } = fixture(directory.path)
  const original = await run(({ tasks, queue }) =>
    Effect.gen(function* () {
      const at = Date.now() + 60_000
      const agent = yield* tasks.create({
        name: "Daily notes",
        objective: "Review project notes",
        schedule: { kind: "once", at },
        enabled: true,
      })
      yield* queue.publish({
        agentID: agent.id,
        version: agent.scheduleVersion ?? 1,
        occurrences: [{ at, observedAt: at }],
      })
      const occurrence = (yield* queue.pending(agent.id, agent.scheduleVersion ?? 1))[0]
      return { agent, occurrence }
    }),
  )
  const first = await run((data) =>
    Effect.gen(function* () {
      const notice = RayaTaskWait.make({
        ...data,
        check: () => Effect.void,
        publish: () => Effect.fail(new Error("Synthetic report destination unavailable")),
      })
      const request = {
        agent: original.agent,
        occurrenceID: original.occurrence.id,
        reason: "deferred" as const,
        now: original.occurrence.observed_at + 30 * 60_000,
      }
      expect(yield* notice.notice(request)).toBeUndefined()
      expect(Exit.isFailure(yield* Effect.exit(notice.notice({ ...request, now: request.now + 1 })))).toBe(true)
      const messages = (yield* data.inbox.page(original.agent.id)).messages
      expect(messages).toHaveLength(1)
      return messages[0]
    }),
  )
  await run((data) =>
    Effect.gen(function* () {
      const projected: string[] = []
      const notice = RayaTaskWait.make({
        ...data,
        check: () => Effect.void,
        publish: (value) =>
          Effect.sync(() => {
            projected.push(value.id)
          }),
      })
      const request = {
        agent: original.agent,
        occurrenceID: original.occurrence.id,
        reason: "busy" as const,
        now: original.occurrence.observed_at + 60 * 60_000,
        quiet: true,
      }
      const retried = yield* notice.notice(request)
      expect(retried?.created).toBe(false)
      expect(retried?.quiet).toBe(true)
      expect(retried?.record).toEqual(first)
      yield* notice.notice(request)
      expect((yield* data.inbox.page(original.agent.id)).messages).toEqual([first])
      expect(projected).toEqual([original.occurrence.id, original.occurrence.id])
    }),
  )
})

test("waiting notices reject changed profile and suppress paused, reassigned or consumed occurrences", async () => {
  await using directory = await tmpdir()
  const { run } = fixture(directory.path)
  await run((data) =>
    Effect.gen(function* () {
      const at = Date.now() + 60_000
      const agent = yield* data.tasks.create({
        name: "Brief",
        objective: "Review notes",
        schedule: { kind: "once", at },
        enabled: true,
      })
      yield* data.queue.publish({
        agentID: agent.id,
        version: agent.scheduleVersion ?? 1,
        occurrences: [{ at, observedAt: at }],
      })
      const row = (yield* data.queue.pending(agent.id, agent.scheduleVersion ?? 1))[0]
      const request = { agent, occurrenceID: row.id, reason: "deferred" as const, now: at + 31 * 60_000 }
      const denied = RayaTaskWait.make({
        ...data,
        check: () => Effect.fail(new RayaTask.GuardError({ message: "Current profile changed" })),
      })
      expect(Exit.isFailure(yield* Effect.exit(denied.notice(request)))).toBe(true)
      const notice = RayaTaskWait.make({ ...data, check: () => Effect.void })
      yield* data.tasks.update(agent.id, { enabled: false })
      expect(yield* notice.notice(request)).toBeUndefined()
      yield* data.tasks.update(agent.id, { enabled: true, objective: "A different assignment" })
      expect(yield* notice.notice(request)).toBeUndefined()
      const current = yield* data.tasks.get(agent.id)
      yield* data.queue.skip(row.id, "Already consumed")
      expect(yield* notice.notice({ ...request, agent: current })).toBeUndefined()
      expect((yield* data.inbox.page(agent.id)).messages).toEqual([])
    }),
  )
})
