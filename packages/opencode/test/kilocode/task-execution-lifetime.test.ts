import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { hostname } from "node:os"
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Scheduler } from "effect"
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
import { admission } from "@/kilocode/task/admission"
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

it.live(
  "revokes admission and joins an exact idle receipt removal before terminal finish returns",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const removing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const observed = yield* Deferred.make<void>()
        const state = { held: false }
        const guarded = {
          create: storage.create,
          replace: storage.replace,
          read: <T>(key: string[]) =>
            storage
              .read<T>(key)
              .pipe(Effect.tap(() => (state.held ? Deferred.succeed(observed, undefined) : Effect.void))),
          remove: (key: string[]) =>
            Effect.gen(function* () {
              if (key[1] === "agent-executions") {
                state.held = true
                yield* Deferred.succeed(removing, undefined)
                yield* Deferred.await(release)
              }
              yield* storage.remove(key)
            }),
        }
        const execution = RayaTaskExecution.make(guarded)
        const owner = identity()
        expect(yield* execution.enter(owner, Effect.succeed("idle"))).toBe("idle")
        const first = yield* execution.finish(owner).pipe(Effect.forkChild)
        yield* Effect.gen(function* () {
          yield* Deferred.await(removing)
          expect(yield* execution.authorized(owner)).toBe(false)
          const done = yield* Deferred.make<void>()
          const second = yield* execution
            .finish(owner)
            .pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.forkChild)
          yield* Deferred.await(observed)
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(done)).toBe(false)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          expect(yield* execution.receipt(owner)).toBeUndefined()
          expect(yield* execution.enter(owner, Effect.succeed("fresh"))).toBe("fresh")
          yield* execution.finish(owner)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "consumes a terminal finish racing the durable idle handoff without leaving its exact receipt",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        for (const _ of Array.from({ length: 32 })) {
          const owner = identity()
          const child = yield* execution.enter(owner, Effect.succeed("finished")).pipe(Effect.forkChild)
          const prior = yield* Effect.gen(function* () {
            while (true) {
              const row = yield* execution.receipt(owner)
              if (row?.state === "idle") return row
              yield* Effect.yieldNow
            }
          }).pipe(Effect.timeout("5 seconds"))
          expect(prior.state).toBe("idle")
          yield* execution.finish(owner)
          expect(yield* Fiber.join(child)).toBe("finished")
          expect(yield* execution.receipt(owner)).toBeUndefined()
          const next = yield* execution.acquire(owner)
          if (!next) throw new Error("Finished execution did not permit a fresh generation")
          expect(next.record.token).not.toBe(prior?.token)
          expect(yield* execution.enter(owner, Effect.succeed("new generation"))).toBe("new generation")
          yield* execution.finish(owner)
          expect(yield* execution.receipt(owner)).toBeUndefined()
        }
      }).pipe(
        Effect.provide(Storage.layerFromDir(path.join(root, "storage"))),
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
      )
    }),
  30_000,
)

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

if (process.platform === "win32")
  it.live(
    "retries exact local idle removal after a real Windows reader denied deletion",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const execution = RayaTaskExecution.make(storage)
          const owner = identity()
          expect(yield* execution.enter(owner, Effect.succeed("idle"))).toBe("idle")
          const prior = yield* execution.receipt(owner)
          if (!prior) throw new Error("Missing actual idle receipt")
          const file = path.join(
            root,
            "storage/raya/agent-executions",
            createHash("sha256").update(owner.id).digest("hex") + ".json",
          )
          const script =
            '$ErrorActionPreference="Stop";$p=[Console]::In.ReadLine();$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Write));try{[Console]::Out.WriteLine("held");[Console]::Out.Flush();[void][Console]::In.ReadLine()}finally{$f.Dispose()}'
          const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          })
          const reader = child.stdout.getReader()
          try {
            yield* Effect.promise(async () => child.stdin.write(file + "\n"))
            const ready = yield* Effect.promise(() => reader.read())
            expect(new TextDecoder().decode(ready.value).trim()).toBe("held")
            const intake = admission()
            const failed = yield* intake
              .track(execution.finish(owner), () => new Error("Admission closed"))
              .pipe(Effect.exit)
            expect(Exit.isFailure(failed)).toBe(true)
            expect((yield* execution.receipt(owner))?.token).toBe(prior.token)
            expect(yield* execution.authorized(owner)).toBe(false)
          } finally {
            yield* Effect.promise(async () => {
              await child.stdin.write("\n")
              await child.stdin.end()
            })
            expect(yield* Effect.promise(() => child.exited)).toBe(0)
            reader.releaseLock()
          }
          expect(yield* execution.finish(owner).pipe(Effect.exit)).toMatchObject({ _tag: "Success" })
          expect(yield* execution.receipt(owner)).toBeUndefined()
        }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
      }),
    30000,
  )

it.live(
  "retains a newer durable generation when an old body finalizes",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        const permit = yield* execution.acquire(owner)
        if (!permit) throw new Error("Missing execution permit")
        const next = { ...permit.record, token: crypto.randomUUID(), state: "idle" as const }
        const result = yield* execution
          .enter(
            owner,
            storage.replace(["raya", "agent-executions", createHash("sha256").update(owner.id).digest("hex")], next),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect((yield* execution.receipt(owner))?.token).toBe(next.token)
        expect(yield* execution.authorized(owner)).toBe(false)
        yield* storage.remove(["raya", "agent-executions", createHash("sha256").update(owner.id).digest("hex")])
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

if (process.platform === "win32")
  it.live(
    "keeps a stopped foreign review retryable after a real deletion fault",
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const execution = RayaTaskExecution.make(storage)
          const run = identity()
          yield* execution.enter(run, Effect.void)
          const prior = yield* execution.receipt(run)
          if (!prior) throw new Error("Missing original receipt")
          const process = Bun.spawn(
            [
              "powershell",
              "-NoProfile",
              "-Command",
              '[Console]::Out.WriteLine($PID);[Console]::Out.WriteLine((Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("O",[Globalization.CultureInfo]::InvariantCulture))',
            ],
            { stdout: "pipe", stderr: "pipe", windowsHide: true },
          )
          const text = yield* Effect.promise(() => new Response(process.stdout).text())
          expect(yield* Effect.promise(() => process.exited)).toBe(0)
          const [pid, birth] = text.trim().split(/\r?\n/)
          expect(Number.isSafeInteger(Number(pid))).toBe(true)
          expect(birth).toMatch(/^\d{4}-.*Z$/)
          const foreign = { ...prior, owner: { host: hostname(), pid: Number(pid), birth } }
          const key = ["raya", "agent-executions", createHash("sha256").update(run.id).digest("hex")]
          yield* storage.replace(key, foreign)
          const file = path.join(root, "storage", ...key) + ".json"
          const script =
            '$ErrorActionPreference="Stop";$p=[Console]::In.ReadLine();$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Write));try{[Console]::Out.WriteLine("held");[Console]::Out.Flush();[void][Console]::In.ReadLine()}finally{$f.Dispose()}'
          const holder = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          })
          const reader = holder.stdout.getReader()
          try {
            yield* Effect.promise(async () => holder.stdin.write(file + "\n"))
            expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value).trim()).toBe("held")
            const intake = admission()
            const failed = yield* intake
              .track(execution.review(run, prior.token), () => new Error("Admission closed"))
              .pipe(Effect.exit)
            expect(Exit.isFailure(failed)).toBe(true)
            if (Exit.isFailure(failed)) {
              expect(Cause.hasFails(failed.cause)).toBe(true)
              expect(Cause.hasDies(failed.cause)).toBe(false)
            }
            yield* Effect.promise(intake.quiesce)
            expect(intake.snapshot().failures).toBe(0)
            expect(yield* execution.receipt(run)).toEqual(foreign)
            const reviews = yield* storage.list(["raya", "agent-execution-reviews", key[2]])
            expect(reviews.length).toBe(1)
            expect((yield* storage.read<{ record: typeof foreign }>(reviews[0])).record).toEqual(foreign)
          } finally {
            yield* Effect.promise(async () => {
              await holder.stdin.write("\n")
              await holder.stdin.end()
            })
            expect(yield* Effect.promise(() => holder.exited)).toBe(0)
            reader.releaseLock()
          }
          yield* execution.review(run, prior.token)
          expect(yield* execution.receipt(run)).toBeUndefined()
        }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
      }),
    30000,
  )
