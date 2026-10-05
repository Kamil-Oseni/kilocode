import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import path from "node:path"
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { Deferred, Effect } from "effect"
import { Flock } from "@opencode-ai/core/util/flock"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SnapshotWorkspace } from "../../src/kilocode/snapshot/workspace"
import { SnapshotRuntime } from "../../src/kilocode/snapshot/runtime"
import { createShutdown } from "../../src/kilocode/cli/shutdown"
import { tmpdir } from "../fixture/fixture"

async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, text, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`Actual Git failure: ${err}`)
  return text.trim()
}
function messages(err: unknown): string {
  return err instanceof AggregateError ? [err.message, ...err.errors.map(messages)].join("\n") : String(err)
}
async function gate(file: string) {
  const root = await resolveProfileRoot({ kind: "json", path: file })
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const done = Flock.withLock(
    root.id,
    async () => {
      ready.resolve()
      await release.promise
    },
    { dir: path.join(path.dirname(root.path), ".raya-profile-locks") },
  )
  await ready.promise
  return { release: release.resolve, done }
}

test("real workspace and exact file gates retain checkout, finalizers, and runtime shutdown", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "file.txt")
  await writeFile(file, "checkpoint")
  await git(tmp.path, "add", "file.txt")
  const tree = await git(tmp.path, "write-tree")
  for (const target of [tmp.path, file]) {
    await writeFile(file, "modified")
    const held = await gate(target)
    const runtime = SnapshotRuntime.make(createShutdown())
    const ownership = runtime.install()
    const end = Deferred.makeUnsafe<void>()
    const state = { started: false, completed: false, settled: false }
    const work = Effect.runPromise(
      SnapshotWorkspace.run(
        { worktree: tmp.path, files: [file] },
        (check) =>
          Effect.gen(function* () {
            yield* check
            state.started = true
            yield* Effect.promise(() => git(tmp.path, "checkout", tree, "--", "file.txt"))
            state.completed = true
          }).pipe(Effect.ensuring(Deferred.await(end))),
        ownership,
      ),
    ).finally(() => {
      state.settled = true
    })
    await Bun.sleep(100)
    expect(state.started).toBe(false)
    expect(runtime.snapshot().controller?.active).toBe(1)
    const closing = Effect.runPromise(runtime.close())
    await assert.rejects(
      Effect.runPromise(SnapshotWorkspace.run({ worktree: tmp.path, files: [file] }, () => Effect.void, ownership)),
      /closed/,
    )
    held.release()
    await held.done
    const limit = Date.now() + 5000
    while (!state.completed) {
      assert(Date.now() < limit, "Actual checkout completion deadline")
      await Bun.sleep(10)
    }
    expect(await readFile(file, "utf8")).toBe("checkpoint")
    expect(state.settled).toBe(false)
    expect(runtime.snapshot().controller?.active).toBe(1)
    await Effect.runPromise(Deferred.succeed(end, undefined))
    await work
    await closing
    expect(runtime.snapshot().controller?.active).toBe(0)
  }
})

test("owned missing parent creation succeeds and unrelated creation before its gate refuses", async () => {
  await using tmp = await tmpdir()
  const parent = path.join(tmp.path, "new")
  const file = path.join(parent, "deep", "file.txt")
  await Effect.runPromise(
    SnapshotWorkspace.run({ worktree: tmp.path, files: [file] }, (check) =>
      check.pipe(Effect.andThen(Effect.promise(() => writeFile(file, "genuine restored file")))),
    ),
  )
  expect(await readFile(file, "utf8")).toBe("genuine restored file")
  const foreign = path.join(tmp.path, "foreign")
  const target = path.join(foreign, "file.txt")
  const held = await gate(foreign)
  const state = { started: false }
  const work = Effect.runPromise(
    SnapshotWorkspace.run({ worktree: tmp.path, files: [target] }, () =>
      Effect.sync(() => {
        state.started = true
      }),
    ),
  )
  const rejected = assert.rejects(work, /EEXIST/)
  await Bun.sleep(100)
  await mkdir(foreign)
  await writeFile(target, "foreign retained")
  held.release()
  await held.done
  await rejected
  expect(state.started).toBe(false)
  expect(await readFile(target, "utf8")).toBe("foreign retained")
})

test("actual parent generation replacement behind exact target gate refuses before mutation", async () => {
  await using tmp = await tmpdir()
  const parent = path.join(tmp.path, "parent")
  await mkdir(parent)
  const file = path.join(parent, "file.txt")
  await writeFile(file, "original")
  const held = await gate(file)
  const state = { started: false }
  const work = Effect.runPromise(
    SnapshotWorkspace.run({ worktree: tmp.path, files: [file] }, () =>
      Effect.promise(async () => {
        state.started = true
        await writeFile(file, "must never write")
      }),
    ),
  )
  const rejected = assert.rejects(work, (err: unknown) => {
    assert(messages(err).includes("Snapshot parent physical identity changed"), messages(err))
    return true
  })
  await Bun.sleep(100)
  await rename(parent, path.join(tmp.path, "original"))
  await mkdir(parent)
  await writeFile(file, "foreign unchanged")
  held.release()
  await assert.rejects(held.done, /lock is compromised/)
  await rejected
  expect(state.started).toBe(false)
  expect(await readFile(file, "utf8")).toBe("foreign unchanged")
})

test("outside paths and real parent junction escape refuse; intended leaf replacement and deletion succeed", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "workspace")
  const foreign = path.join(tmp.path, "foreign")
  await mkdir(root)
  await mkdir(foreign)
  await assert.rejects(
    Effect.runPromise(
      SnapshotWorkspace.run({ worktree: root, files: [path.join(foreign, "file")] }, () => Effect.void),
    ),
    /outside/,
  )
  const alias = path.join(root, "alias")
  await symlink(foreign, alias, process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(
    Effect.runPromise(SnapshotWorkspace.run({ worktree: root, files: [path.join(alias, "file")] }, () => Effect.void)),
    /regular directory|canonical target escapes/,
  )
  const file = path.join(root, "file")
  await writeFile(file, "before")
  const before = await lstat(file, { bigint: true })
  await Effect.runPromise(
    SnapshotWorkspace.run({ worktree: root, files: [file] }, (check) =>
      Effect.gen(function* () {
        yield* check
        const next = path.join(root, "next")
        yield* Effect.promise(() => writeFile(next, "after"))
        yield* Effect.promise(() => rename(next, file))
        yield* check
        expect((yield* Effect.promise(() => lstat(file, { bigint: true }))).ino).not.toBe(before.ino)
        yield* Effect.promise(() => rm(file))
        yield* check
      }),
    ),
  )
  await assert.rejects(lstat(file), { code: "ENOENT" })
})

test("real body failure and parent finalizer replacement both remain visible", async () => {
  await using tmp = await tmpdir({ git: true })
  const parent = path.join(tmp.path, "parent")
  await mkdir(parent)
  const file = path.join(parent, "file")
  await writeFile(file, "original")
  await assert.rejects(
    Effect.runPromise(
      SnapshotWorkspace.run({ worktree: tmp.path, files: [file] }, () =>
        Effect.promise(() => git(tmp.path, "not-a-real-command")).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              await rename(parent, path.join(tmp.path, "old"))
              await mkdir(parent)
            }),
          ),
        ),
      ),
    ),
    (err: unknown) => {
      const text = messages(err)
      assert(text.includes("Actual Git failure"), text)
      assert(text.includes("Snapshot parent physical identity changed"), text)
      return true
    },
  )
})

test("genuine internal leaf link replacement preserves destination; outside leaf link refuses", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "workspace")
  const inside = path.join(root, "destination")
  const outside = path.join(tmp.path, "outside")
  await mkdir(inside, { recursive: true })
  await mkdir(outside)
  const original = path.join(inside, "retained.txt")
  await writeFile(original, "destination retained")
  const link = path.join(root, "link")
  await symlink(inside, link, process.platform === "win32" ? "junction" : "dir")
  await Effect.runPromise(
    SnapshotWorkspace.run({ worktree: root, files: [link] }, (check) =>
      Effect.gen(function* () {
        yield* check
        yield* Effect.promise(() => rm(link))
        yield* Effect.promise(() => writeFile(link, "restored regular leaf"))
        yield* check
      }),
    ),
  )
  expect(await readFile(link, "utf8")).toBe("restored regular leaf")
  expect(await readFile(original, "utf8")).toBe("destination retained")
  await Effect.runPromise(
    SnapshotWorkspace.run({ worktree: root, files: [link] }, (check) =>
      Effect.gen(function* () {
        yield* check
        yield* Effect.promise(() => rm(link))
        yield* Effect.promise(() => symlink(inside, link, process.platform === "win32" ? "junction" : "dir"))
        yield* check
      }),
    ),
  )
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await readFile(original, "utf8")).toBe("destination retained")
  await assert.rejects(
    Effect.runPromise(
      SnapshotWorkspace.run({ worktree: root, files: [link] }, (check) =>
        Effect.gen(function* () {
          yield* check
          yield* Effect.promise(() => rm(link))
          yield* Effect.promise(() => symlink(outside, link, process.platform === "win32" ? "junction" : "dir"))
          yield* check
        }),
      ),
    ),
    (err: unknown) => {
      assert(err instanceof AggregateError)
      assert(err.errors.length >= 2)
      assert(messages(err).includes("Snapshot leaf link escapes its workspace"))
      return true
    },
  )
  expect(await readFile(original, "utf8")).toBe("destination retained")
  await assert.rejects(
    Effect.runPromise(SnapshotWorkspace.run({ worktree: root, files: [link] }, () => Effect.void)),
    /leaf link escapes|canonical target escapes/,
  )
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
})
