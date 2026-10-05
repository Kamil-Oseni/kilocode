import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { WorktreeAdmission } from "../../src/kilocode/worktree/admission"
import { createShutdown } from "../../src/kilocode/cli/shutdown"
import { ProfileWriterRegistry } from "../../src/kilocode/migration/writer-registry"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { tmpdir } from "../fixture/fixture"

async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`Actual Git failed: ${err}`)
  return out.trim()
}

function fixture() {
  const shutdown = createShutdown()
  const registry = ProfileWriterRegistry.make(["profile.data.worktrees"])
  const publications: string[][] = []
  const boundary = WorktreeAdmission.make(
    shutdown,
    () => {
      Effect.runSync(registry.register("profile.data.worktrees"))
      return ProfileWriterLive.from(registry, "profile.data.worktrees")
    },
    (roots) => publications.push([...roots]),
  )
  return { boundary, shutdown, registry, publications }
}

test("actual Git namespace gates retain accepted discovery before effects and retirement", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = fixture()
  const scope = Effect.runSync(Scope.make())
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const held = coordinateNativeRoots([{ kind: "json", path: path.join(tmp.path, ".git") }], async () => {
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
  })
  await Effect.runPromise(Deferred.await(entered))
  const selection = Effect.promise(() => WorktreeAdmission.roots([tmp.path, path.join(tmp.path, ".git")]))
  const work = Effect.runPromise(
    state.boundary.run(
      selection,
      Effect.promise(async () => {
        await writeFile(path.join(tmp.path, "admitted.txt"), "real admitted Git write")
        await git(tmp.path, "add", "admitted.txt")
        return git(tmp.path, "write-tree")
      }),
      scope,
    ),
  )
  const settled = work.then(
    () => "done",
    () => "failed",
  )
  await Bun.sleep(100)
  expect(state.boundary.snapshot().active).toBe(1)
  expect((await Effect.runPromise(state.registry.snapshot)).active).toEqual([
    { id: "profile.data.worktrees", count: 1 },
  ])
  expect(await Bun.file(path.join(tmp.path, "admitted.txt")).exists()).toBe(false)
  expect(state.publications).toHaveLength(0)
  const closed = state.shutdown.run()
  expect(await Promise.race([settled, Bun.sleep(40).then(() => "pending")])).toBe("pending")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await held
  expect(await work).toMatch(/^[0-9a-f]{40,64}$/)
  await closed
  expect(await git(tmp.path, "ls-files", "admitted.txt")).toBe("admitted.txt")
  expect(state.boundary.snapshot()).toEqual({ closing: true, active: 0, failures: 0 })
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

test("public return retains an actual startup child and finalizer through shutdown", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = fixture()
  const scope = Effect.runSync(Scope.make())
  const dir = path.join(tmp.path, "linked")
  const release = path.join(tmp.path, "release")
  const started = Deferred.makeUnsafe<void>()
  const terminal = Deferred.makeUnsafe<number>()
  const selection = Effect.promise(() => WorktreeAdmission.roots([tmp.path, path.join(tmp.path, ".git")], [dir]))
  const body = Effect.gen(function* () {
    yield* Effect.promise(() => git(tmp.path, "worktree", "add", "--detach", dir, "HEAD"))
    yield* state.boundary.background(
      Effect.promise(async () => {
        const script =
          "const deadline=Date.now()+15000; while(!(await Bun.file(process.argv[1]).exists())) {if(Date.now()>deadline) throw new Error('fixture deadline'); await Bun.sleep(10)} await Bun.write(process.argv[2], 'actual startup completed')"
        const child = Bun.spawn([process.execPath, "-e", script, release, path.join(dir, "started.txt")], {
          cwd: dir,
          stdout: "ignore",
          stderr: "pipe",
          windowsHide: true,
        })
        await Effect.runPromise(Deferred.succeed(started, undefined))
        const code = await child.exited
        const err = await new Response(child.stderr).text()
        await Effect.runPromise(Deferred.succeed(terminal, code))
        if (code) throw new Error(`Actual startup failed: ${err}`)
      }).pipe(
        Effect.ensuring(Effect.promise(() => writeFile(path.join(tmp.path, "finalized.txt"), "joined finalizer"))),
      ),
      scope,
    )
    return dir
  })
  expect(await Effect.runPromise(state.boundary.run(selection, body, scope))).toBe(dir)
  await Effect.runPromise(Deferred.await(started))
  expect(state.boundary.snapshot().active).toBe(1)
  const closed = state.shutdown.run()
  const settled = closed.then(
    () => "done",
    () => "failed",
  )
  await Bun.sleep(20)
  const late = await Effect.runPromiseExit(state.boundary.run(selection, Effect.void, scope))
  expect(Exit.isFailure(late)).toBe(true)
  expect(await Promise.race([settled, Bun.sleep(50).then(() => "pending")])).toBe("pending")
  expect((await Effect.runPromise(state.registry.snapshot)).active).toEqual([
    { id: "profile.data.worktrees", count: 1 },
  ])
  await writeFile(release, "release actual child")
  await closed
  expect(await Effect.runPromise(Deferred.await(terminal))).toBe(0)
  expect(await Bun.file(path.join(dir, "started.txt")).text()).toBe("actual startup completed")
  expect(await Bun.file(path.join(tmp.path, "finalized.txt")).text()).toBe("joined finalizer")
  expect((await Effect.runPromise(state.registry.snapshot)).active).toEqual([])
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await git(tmp.path, "worktree", "remove", "--force", dir)
})

test("actual namespace replacement and original body failures remain sticky", async () => {
  await using tmp = await tmpdir()
  for (const replace of [false, true]) {
    const state = fixture()
    const scope = Effect.runSync(Scope.make())
    const dir = path.join(tmp.path, replace ? "replace" : "failure")
    await mkdir(dir)
    const original = new Error("original admitted failure")
    const exit = await Effect.runPromiseExit(
      state.boundary.run(
        Effect.promise(() => WorktreeAdmission.roots([dir])),
        replace
          ? Effect.promise(async () => {
              await rename(dir, `${dir}-old`)
              await mkdir(dir)
            })
          : Effect.fail(original),
        scope,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!replace && Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original)
    expect(state.boundary.snapshot().active).toBe(0)
    expect(state.boundary.snapshot().failures).toBe(1)
    await rejects(state.shutdown.run())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("pre-admission refusal allows later real work and a successful shutdown", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = fixture()
  const scope = Effect.runSync(Scope.make())
  const original = new Error("safe read-only validation refusal")
  const exit = await Effect.runPromiseExit(state.boundary.run(Effect.fail(original), Effect.void, scope))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original)
  expect(state.boundary.snapshot().failures).toBe(0)
  await Effect.runPromise(
    state.boundary.run(
      Effect.promise(() => WorktreeAdmission.roots([tmp.path])),
      Effect.promise(async () => {
        await writeFile(path.join(tmp.path, "later.txt"), "later actual admitted write")
        await git(tmp.path, "add", "later.txt")
      }),
      scope,
    ),
  )
  await state.shutdown.run()
  expect(await git(tmp.path, "ls-files", "later.txt")).toBe("later.txt")
  expect(state.boundary.snapshot()).toEqual({ closing: true, active: 0, failures: 0 })
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

test("ordinary scope cancellation joins the authentic background finalizer", async () => {
  await using tmp = await tmpdir()
  const state = fixture()
  const scope = Effect.runSync(Scope.make())
  const entered = Deferred.makeUnsafe<void>()
  const parked = Deferred.makeUnsafe<void>()
  const selection = Effect.promise(() => WorktreeAdmission.roots([tmp.path]))
  await Effect.runPromise(
    state.boundary.run(
      selection,
      Effect.gen(function* () {
        yield* state.boundary.background(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(parked)),
            Effect.ensuring(
              Effect.promise(() => writeFile(path.join(tmp.path, "cancelled-finalizer.txt"), "actual finalizer")),
            ),
          ),
          scope,
        )
      }),
      scope,
    ),
  )
  await Effect.runPromise(Deferred.await(entered))
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await state.shutdown.run()
  expect(await Bun.file(path.join(tmp.path, "cancelled-finalizer.txt")).text()).toBe("actual finalizer")
  expect(state.boundary.snapshot()).toEqual({ closing: true, active: 0, failures: 0 })
})

test("caught validation cannot exempt a later mutation or another operation", async () => {
  await using tmp = await tmpdir({ git: true })
  for (const reused of [false, true]) {
    const state = fixture()
    const scope = Effect.runSync(Scope.make())
    const original = new Error("authentic read-only refusal reused after mutation")
    const selection = Effect.promise(() => WorktreeAdmission.roots([tmp.path]))
    if (reused) {
      const exit = await Effect.runPromiseExit(state.boundary.run(selection, state.boundary.reject(original), scope))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(state.boundary.snapshot().failures).toBe(0)
    }
    const body = Effect.gen(function* () {
      if (!reused) yield* state.boundary.reject(original).pipe(Effect.catch(() => Effect.void))
      yield* state.boundary.mutate(
        Effect.promise(() => writeFile(path.join(tmp.path, `mutated-${reused}.txt`), "actual mutation")),
      )
      return yield* Effect.fail(original)
    })
    const exit = await Effect.runPromiseExit(state.boundary.run(selection, body, scope))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original)
    expect(state.boundary.snapshot().failures).toBe(1)
    expect(await Bun.file(path.join(tmp.path, `mutated-${reused}.txt`)).text()).toBe("actual mutation")
    await rejects(state.shutdown.run())
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
