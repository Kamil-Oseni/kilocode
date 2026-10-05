import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { KiloSnapshotSeed } from "../../src/kilocode/snapshot/seed"
import { KiloSnapshotMaterialize } from "../../src/kilocode/snapshot/materialize"
import { SnapshotSource } from "../../src/kilocode/snapshot/source"
import { SnapshotRuntime } from "../../src/kilocode/snapshot/runtime"
import { createShutdown } from "../../src/kilocode/cli/shutdown"
import { tmpdir } from "../fixture/fixture"

const git: KiloSnapshotMaterialize.Git = (cmd, opts) =>
  Effect.promise(async () => {
    const child = Bun.spawn(["git", ...cmd], {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdin: opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [code, text, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, text, stderr }
  })
async function command(...cmd: string[]) {
  const result = await Effect.runPromise(git(cmd))
  if (result.code) throw new Error(result.stderr)
  return result.text.trim()
}
async function seed(dir: string, gitdir: string, ownership: SnapshotSource.Ownership) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* KiloSnapshotSeed.seed({
        dir,
        worktree: dir,
        gitdir,
        limit: 1024 * 1024,
        git,
        write: git,
        fs,
        ownership,
      })
    }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node))),
  )
}
async function materialize(gitdir: string, ownership: SnapshotSource.Ownership) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* KiloSnapshotMaterialize.run({ gitdir, git, write: git, fs, ownership })
    }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node))),
  )
}

test("linked worktree seed waits for actual common repository maintenance before writes", async () => {
  await using tmp = await tmpdir({ git: true })
  await writeFile(path.join(tmp.path, "tracked.txt"), "committed")
  await command("-C", tmp.path, "add", "tracked.txt")
  await command("-C", tmp.path, "commit", "-m", "baseline")
  const dir = path.join(tmp.path, "linked")
  await command("-C", tmp.path, "worktree", "add", "-b", "linked", dir)
  const common = await command("-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const local = await command("-C", dir, "rev-parse", "--path-format=absolute", "--git-dir")
  expect(local).not.toBe(common)
  const index = await command("-C", dir, "rev-parse", "--path-format=absolute", "--git-path", "index")
  const before = await readFile(index)
  const gitdir = path.join(tmp.path, "snapshot.git")
  await command("init", "--bare", gitdir)
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const held = coordinateNativeRoots([{ kind: "json", path: common }], async () => {
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
  }).then(
    () => undefined,
    (err) => err,
  )
  await Effect.runPromise(Deferred.await(entered))
  const work = seed(dir, gitdir, port)
  const settled = work.then(
    () => "done",
    () => "failed",
  )
  expect(await Promise.race([settled, Bun.sleep(100).then(() => "pending")])).toBe("pending")
  expect(await Bun.file(path.join(gitdir, "seed.index")).exists()).toBe(false)
  expect(await command("--git-dir", common, "for-each-ref", KiloSnapshotMaterialize.ref(gitdir))).toBe("")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await held).toBeUndefined()
  const result = await work
  expect(result.source?.gitdir.replaceAll("\\", "/")).toBe(common.replaceAll("\\", "/"))
  expect(await readFile(index)).toEqual(before)
  expect(await materialize(gitdir, port)).toBe(true)
  expect(await command("--git-dir", common, "for-each-ref", KiloSnapshotMaterialize.ref(gitdir))).toBe("")
  await Effect.runPromise(runtime.close())
}, 20000)

test("real source ref lock refusal survives seed cold fallback and materialization false fallback", async () => {
  await using tmp = await tmpdir({ git: true })
  await writeFile(path.join(tmp.path, "tracked.txt"), "committed")
  await command("-C", tmp.path, "add", "tracked.txt")
  const common = path.join(tmp.path, ".git")
  const gitdir = path.join(tmp.path, "snapshot.git")
  await command("init", "--bare", gitdir)
  const ref = KiloSnapshotMaterialize.ref(gitdir)
  const lock = path.join(common, `${ref}.lock`)
  await mkdir(path.dirname(lock), { recursive: true })
  await writeFile(lock, "foreign Git lock")
  const first = SnapshotRuntime.make(createShutdown())
  expect(await seed(tmp.path, gitdir, first.install())).toEqual({})
  expect(await readFile(lock, "utf8")).toBe("foreign Git lock")
  await rejects(Effect.runPromise(first.close()), /Snapshot Git mutation refused/)
  await rm(lock)
  const second = SnapshotRuntime.make(createShutdown())
  const port = second.install()
  expect((await seed(tmp.path, gitdir, port)).source).toBeDefined()
  await writeFile(lock, "foreign Git deletion lock")
  expect(await materialize(gitdir, port)).toBe(false)
  expect(await readFile(lock, "utf8")).toBe("foreign Git deletion lock")
  expect(await command("--git-dir", common, "rev-parse", "--verify", ref)).toMatch(/^[0-9a-f]{40}$/)
  await rejects(Effect.runPromise(second.close()), /Snapshot Git mutation refused/)
}, 20000)

test("source generation cannot be replaced between seed and later cleanup", async () => {
  await using tmp = await tmpdir({ git: true })
  const dir = path.join(tmp.path, ".git")
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  await Effect.runPromise(
    SnapshotSource.run({ ownership: port }, dir, git(["--git-dir", dir, "config", "owned.value", "original"])),
  )
  await rename(dir, `${dir}.original`)
  await command("init", "--bare", dir)
  await rejects(
    Effect.runPromise(
      SnapshotSource.run({ ownership: port }, dir, git(["--git-dir", dir, "config", "owned.value", "replacement"])),
    ),
    /physical generation changed/,
  )
  const value = await Effect.runPromise(git(["--git-dir", dir, "config", "--get", "owned.value"]))
  expect(value.code).toBe(1)
  await rejects(Effect.runPromise(runtime.close()))
})

test("owned interrupted source work keeps common lease through real ref cleanup and finalizer", async () => {
  await using tmp = await tmpdir({ git: true })
  await writeFile(path.join(tmp.path, "tracked.txt"), "committed")
  await command("-C", tmp.path, "add", "tracked.txt")
  const hash = await command("-C", tmp.path, "write-tree")
  const dir = path.join(tmp.path, ".git")
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const entered = Deferred.makeUnsafe<void>()
  const cleanup = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const fiber = await Effect.runPromise(
    port.launch(
      { namespaces: [tmp.path] },
      SnapshotSource.run(
        { ownership: port },
        dir,
        Effect.gen(function* () {
          yield* SnapshotSource.write(
            { ownership: port },
            git(["--git-dir", dir, "update-ref", "refs/kilo/interrupted", hash]),
          )
          yield* Deferred.succeed(entered, undefined)
          yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* SnapshotSource.write(
                { ownership: port },
                git(["--git-dir", dir, "update-ref", "-d", "refs/kilo/interrupted", hash]),
              )
              yield* Deferred.succeed(cleanup, undefined)
              yield* Deferred.await(release)
              yield* Effect.promise(() => writeFile(path.join(tmp.path, "cleanup.complete"), "joined"))
            }),
          ),
        ),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(entered))
  await Effect.runPromise(port.cancel(fiber))
  await Effect.runPromise(Deferred.await(cleanup))
  const enteredGate = { value: false }
  const gate = coordinateNativeRoots([{ kind: "json", path: dir }], async () => {
    enteredGate.value = true
  })
  const settled = gate.then(
    () => "done",
    (err) => err,
  )
  expect(await Promise.race([settled, Bun.sleep(100).then(() => "pending")])).toBe("pending")
  expect(enteredGate.value).toBe(false)
  const close = Effect.runPromise(runtime.close())
  const closed = close.then(
    () => "done",
    (err) => err,
  )
  expect(await Promise.race([closed, Bun.sleep(50).then(() => "pending")])).toBe("pending")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(Fiber.await(fiber))
  expect(await settled).toBe("done")
  await close
  expect(await readFile(path.join(tmp.path, "cleanup.complete"), "utf8")).toBe("joined")
  expect(await command("--git-dir", dir, "for-each-ref", "refs/kilo/interrupted")).toBe("")
}, 20000)

test("actual seed interrupted after completed private read-tree retires source pin and copied index", async () => {
  await using tmp = await tmpdir({ git: true })
  await writeFile(path.join(tmp.path, "tracked.txt"), "committed")
  await command("-C", tmp.path, "add", "tracked.txt")
  const dir = path.join(tmp.path, ".git")
  const gitdir = path.join(tmp.path, "snapshot.git")
  await command("init", "--bare", gitdir)
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const reached = Deferred.makeUnsafe<void>()
  const write: KiloSnapshotMaterialize.Git = (cmd, opts) =>
    git(cmd, opts).pipe(
      Effect.flatMap((result) => {
        // Every command executes actual Git. Only return from a completed mutation is held by this callback.
        if (result.code === 0 && cmd[1] === gitdir && cmd.includes("read-tree") && cmd.at(-1) !== "--empty")
          return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
        return Effect.succeed(result)
      }),
    )
  const fiber = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* port.launch(
        { namespaces: [gitdir] },
        KiloSnapshotSeed.seed({
          dir: tmp.path,
          worktree: tmp.path,
          gitdir,
          git,
          write,
          fs,
          ownership: port,
          limit: 1024 * 1024,
        }),
      )
    }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node))),
  )
  await Effect.runPromise(Deferred.await(reached))
  expect(await command("--git-dir", dir, "rev-parse", "--verify", KiloSnapshotMaterialize.ref(gitdir))).toMatch(
    /^[0-9a-f]{40}$/,
  )
  await Effect.runPromise(port.cancel(fiber))
  await Effect.runPromise(Fiber.await(fiber))
  await Effect.runPromise(runtime.close())
  expect(await command("--git-dir", dir, "for-each-ref", KiloSnapshotMaterialize.ref(gitdir))).toBe("")
  expect(await Bun.file(path.join(gitdir, "seed.index")).exists()).toBe(false)
  expect(await Bun.file(path.join(gitdir, "objects", "info", "alternates")).exists()).toBe(false)
}, 20000)
