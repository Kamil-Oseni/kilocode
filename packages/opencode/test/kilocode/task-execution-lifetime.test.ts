import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const identity = () => ({
  id: crypto.randomUUID(),
  agentID: crypto.randomUUID(),
  sessionID: SessionID.make("ses_lifetime"),
})
const session = (id: SessionID) => ({
  id,
  slug: "execution",
  title: "Routine execution",
  projectID: ProjectV2.ID.make("project"),
  directory: "/tmp",
  version: "test",
  time: { created: Date.now(), updated: Date.now() },
})

function idle(storage: Storage.Interface, run: RayaTask.Run) {
  const execution = RayaTaskExecution.make(storage)
  return Effect.gen(function* () {
    while (!(yield* execution.acquire(run))) yield* Effect.sleep("10 millis")
  }).pipe(Effect.timeout("5 seconds"))
}

it.live(
  "allows exact body nesting while refusing a fork that inherited its capability",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        const result = yield* execution.enter(
          owner,
          Effect.gen(function* () {
            expect(yield* execution.enter(owner, Effect.succeed("nested"))).toBe("nested")
            expect(
              yield* execution.enter(
                { ...owner, agentID: crypto.randomUUID() },
                Effect.die("Changed agent identity inherited continuing authority"),
              ),
            ).toBeUndefined()
            const sibling = yield* execution
              .enter(owner, Effect.die("Inherited capability admitted a different fiber"))
              .pipe(Effect.forkChild)
            expect(yield* Fiber.join(sibling)).toBeUndefined()
            yield* execution.finish(owner)
            expect(yield* execution.authorized(owner)).toBe(true)
            return "joined"
          }),
        )
        expect(result).toBe("joined")
        expect(yield* execution.authorized(owner)).toBeUndefined()
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "retains terminal ownership until the actual busy body joins successfully",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const child = yield* execution
          .enter(
            owner,
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return "finished"
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* execution.finish(owner)
        expect(yield* execution.authorized(owner)).toBe(true)
        expect(yield* execution.acquire(owner)).toBeUndefined()
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(1)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(child)).toBe("finished")
        expect(yield* execution.authorized(owner)).toBeUndefined()
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(0)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "keeps the body busy until its successful idle receipt is durable",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const gate = { held: false }
        const delayed = {
          create: storage.create,
          read: storage.read,
          remove: storage.remove,
          replace: (key: string[], content: unknown) =>
            Effect.gen(function* () {
              if (!gate.held && (content as { state?: string }).state === "idle") {
                gate.held = true
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }
              yield* storage.replace(key, content)
            }),
        }
        const execution = RayaTaskExecution.make(delayed)
        const owner = identity()
        const first = yield* execution.enter(owner, Effect.succeed("joined")).pipe(Effect.forkChild)
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        const state = { entered: false }
        yield* Effect.gen(function* () {
          const second = yield* execution
            .enter(
              owner,
              Effect.sync(() => {
                state.entered = true
                return "second"
              }),
            )
            .pipe(Effect.forkChild)
          yield* Effect.sleep("100 millis")
          expect(state.entered).toBe(false)
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(first)).toBe("joined")
          expect(yield* Fiber.join(second)).toBe("second")
          expect(state.entered).toBe(true)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        expect(yield* execution.authorized(owner)).toBe(true)
        yield* execution.finish(owner)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "retains durable uncertainty when the successful idle receipt cannot be written",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const guarded = {
          create: storage.create,
          read: storage.read,
          remove: storage.remove,
          replace: (key: string[], content: unknown) =>
            (content as { state?: string }).state === "idle"
              ? Effect.die(new Error("injected idle receipt failure"))
              : storage.replace(key, content),
        }
        const execution = RayaTaskExecution.make(guarded)
        const owner = identity()
        const result = yield* execution.enter(owner, Effect.succeed("joined")).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* execution.authorized(owner)).toBe(false)
        expect(yield* execution.enter(owner, Effect.die("Uncertain successful work was replayed"))).toBeUndefined()
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(1)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "retains failed execution evidence and refuses automatic same-process reentry",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        const result = yield* execution.enter(owner, Effect.fail("unknown execution")).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* execution.authorized(owner)).toBe(false)
        expect(yield* execution.enter(owner, Effect.die("Uncertain work was replayed"))).toBeUndefined()
        yield* execution.finish(owner)
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(1)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "does not dispatch when admission completes after its absolute deadline",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        expect(yield* execution.acquire(owner)).toBeDefined()
        const slow = RayaTaskExecution.make({
          create: storage.create,
          replace: storage.replace,
          remove: storage.remove,
          read: <T>(key: string[]) => storage.read<T>(key).pipe(Effect.delay("5100 millis")),
        })
        expect(yield* slow.enter(owner, Effect.die("Late admission dispatched continuing work"))).toBeUndefined()
        expect(yield* execution.authorized(owner)).toBe(true)
        yield* execution.finish(owner)
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(0)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "refuses to finish a changed execution identity",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        expect(yield* execution.acquire(owner)).toBeDefined()
        const changed = yield* execution.finish({ ...owner, agentID: crypto.randomUUID() }).pipe(Effect.exit)
        expect(Exit.isFailure(changed)).toBe(true)
        expect(yield* execution.authorized(owner)).toBe(true)
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(1)
        yield* execution.finish(owner)
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(0)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "releases an idle successful owner after exact terminal reconciliation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        expect(yield* execution.enter(owner, Effect.succeed("complete"))).toBe("complete")
        expect(yield* execution.authorized(owner)).toBe(true)
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(1)
        yield* execution.finish(owner)
        expect(yield* execution.authorized(owner)).toBeUndefined()
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(0)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "runner stop releases only idle owners whose session halt is proven",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const storage = yield* Storage.Service
        const turns = yield* Queue.unbounded<RayaTask.Run>()
        const rows = new Map<SessionID, Session.Info>()
        let created = 0
        let fail = true
        const runner = RayaTaskRunner.make({
          database,
          storage,
          halt: (id) => (id.endsWith("fail") && fail ? Effect.die(new Error("halt failed")) : Effect.void),
          sessions: {
            create: (opts) =>
              Effect.sync(() => {
                created++
                const row = {
                  ...session(SessionID.make(created === 1 ? "ses_stop_ok" : "ses_stop_fail")),
                  metadata: opts?.metadata,
                  permission: opts?.permission?.map((rule) => ({ ...rule })),
                  agent: opts?.agent,
                  model: opts?.model,
                }
                rows.set(row.id, row)
                return row
              }),
            get: (id) =>
              Effect.sync(() => {
                const row = rows.get(id)
                if (!row) throw new Error("Unknown retained fixture session")
                return row
              }),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          },
          continuation: (run) => Queue.offer(turns, run).pipe(Effect.asVoid),
        })
        const chief = yield* runner.tasks.create({
          name: "Chief",
          role: "generalist",
          objective: "Coordinate work",
          access: "brief",
          enabled: true,
          schedule: { kind: "manual" },
        })
        const worker = yield* runner.tasks.create({
          name: "Worker",
          role: "generalist",
          objective: "Complete work",
          access: "full",
          enabled: true,
          schedule: { kind: "manual" },
        })
        const execution = RayaTaskExecution.make(storage)

        const first = yield* runner.delegate({
          source: "stop_ok",
          senderID: chief.id,
          recipientID: worker.id,
          objective: "First task",
        })
        const run = yield* Queue.take(turns).pipe(Effect.timeout("5 seconds"))
        yield* idle(storage, run)
        expect(yield* execution.authorized(run)).toBe(true)
        yield* runner.stop(first.id)
        expect(yield* execution.authorized(run)).toBeUndefined()

        const second = yield* runner.delegate({
          source: "stop_fail",
          senderID: chief.id,
          recipientID: worker.id,
          objective: "Second task",
        })
        const failed = yield* Queue.take(turns).pipe(Effect.timeout("5 seconds"))
        yield* idle(storage, failed)
        expect(yield* execution.authorized(failed)).toBe(true)
        yield* runner.stop(second.id)
        expect(yield* execution.authorized(failed)).toBe(true)
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(1)
        fail = false
        yield* runner.stop(second.id)
        expect(yield* execution.authorized(failed)).toBeUndefined()
        expect((yield* storage.list(["raya", "agent-executions"])).length).toBe(0)
      }).pipe(
        Effect.provide(Database.layerFromPath(":memory:")),
        Effect.provide(Storage.layerFromDir(path.join(root, "storage"))),
        Effect.scoped,
      )
    }),
  30_000,
)
