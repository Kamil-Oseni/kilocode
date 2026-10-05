import { expect } from "bun:test"
import path from "node:path"
import { existsSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { InstanceState } from "../../src/effect/instance-state"
import { Worktree } from "../../src/worktree"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { WorktreeAdmission } from "../../src/kilocode/worktree/admission"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Worktree.node, [[InstanceStore.bootstrapNode, InstanceBootstrap.node]]))

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Actual worktree fixture did not settle")
    await Bun.sleep(10)
  }
}

it.instance(
  "actual Worktree planning waits for its selected data gate",
  () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const service = yield* Worktree.Service
      const root = path.join(Global.Path.data, "worktree", ctx.project.id)
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const held = coordinateNativeRoots([{ kind: "json", path: root }], async () => {
        await Effect.runPromise(Deferred.succeed(entered, undefined))
        await Effect.runPromise(Deferred.await(release))
      })
      yield* Deferred.await(entered)
      yield* Effect.gen(function* () {
        const work = yield* service.plan({ name: "admission-real-plan" }).pipe(Effect.forkScoped)
        yield* Effect.promise(() => Bun.sleep(80))
        expect(WorktreeAdmission.snapshot().active).toBe(1)
        expect(
          (yield* ProfileWriterLive.snapshot).active.find((row) => row.id === "profile.data.worktrees")?.count,
        ).toBe(1)
        expect(existsSync(root)).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Effect.promise(() => held)
        const info = yield* Fiber.join(work)
        expect(path.dirname(info.directory)).toBe(root)
        expect(existsSync(root)).toBe(true)
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    }),
  { git: true },
  30_000,
)

it.instance(
  "actual asynchronous creation retains startup ownership and remains removable",
  () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const service = yield* Worktree.Service
      const info = yield* service.plan({ name: "admission-real-create" })
      const dir = path.join(ctx.worktree, "fixture with spaces")
      yield* Effect.promise(() => mkdir(dir))
      const script = path.join(dir, "startup with spaces.ts")
      const exe = path.join(dir, process.platform === "win32" ? "bun with spaces.exe" : "bun with spaces")
      yield* Effect.promise(() => copyFile(process.execPath, exe))
      const release = path.join(dir, "release")
      const started = path.join(dir, "started")
      const finished = path.join(dir, "finished")
      const events: string[] = []
      const on = (event: GlobalEvent) => {
        if (event.directory === info.directory) events.push(event.payload.type)
      }
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
      yield* Effect.promise(() =>
        Bun.write(
          script,
          "await Bun.write(process.argv[2], 'started'); const deadline=Date.now()+15000; while (!(await Bun.file(process.argv[3]).exists())) {if(Date.now()>deadline) throw new Error('fixture deadline'); await Bun.sleep(10)} await Bun.write(process.argv[4], 'finished')",
        ),
      )
      yield* Effect.gen(function* () {
        yield* service.createFromInfo(info, `"${exe}" "${script}" "${started}" "${release}" "${finished}"`)
        yield* Effect.promise(() =>
          until(() => existsSync(started)).catch((err) => {
            console.log(
              JSON.stringify({ phase: "startup-sentinel-timeout", events, runtime: WorktreeAdmission.snapshot() }),
            )
            throw err
          }),
        )
        expect(WorktreeAdmission.snapshot().active).toBe(1)
        expect(
          (yield* ProfileWriterLive.snapshot).active.find((row) => row.id === "profile.data.worktrees")?.count,
        ).toBe(1)
        expect(existsSync(finished)).toBe(false)
        yield* Effect.promise(() => Bun.write(release, "actual release"))
        yield* Effect.promise(() => until(() => WorktreeAdmission.snapshot().active === 0))
        expect(yield* Effect.promise(() => Bun.file(finished).text())).toBe("finished")
        expect(yield* service.remove({ directory: info.directory })).toBe(true)
        expect(existsSync(info.directory)).toBe(false)
      }).pipe(Effect.ensuring(Effect.promise(() => Bun.write(release, "actual release"))))
    }),
  { git: true },
  30_000,
)

it.instance(
  "non-Git validation preserves the public error without poisoning retirement",
  () =>
    Effect.gen(function* () {
      const service = yield* Worktree.Service
      const before = WorktreeAdmission.snapshot().failures
      const exit = yield* Effect.exit(service.plan())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.NotGitError)
      expect(WorktreeAdmission.snapshot().failures).toBe(before)
    }),
  { git: false },
)
