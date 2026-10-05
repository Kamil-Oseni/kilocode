import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SnapshotPin } from "../../src/kilocode/snapshot/pin"
import { SnapshotRuntime } from "../../src/kilocode/snapshot/runtime"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { createShutdown } from "../../src/kilocode/cli/shutdown"
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

function flattened(err: unknown): unknown[] {
  return err instanceof AggregateError ? err.errors.flatMap(flattened) : [err]
}

test("actual lazy Snapshot registration remains statically unintegrated and retains full held Git lifetime", async () => {
  await using tmp = await tmpdir({ git: true })
  expect(() => ProfileWriterLive.admission("profile.data.snapshots")).toThrow("not integrated")
  const first = ProfileWriterLive.snapshots()
  expect(ProfileWriterLive.snapshots()).toBe(first)
  expect(
    (await Effect.runPromise(ProfileWriterLive.snapshot)).registered.filter((id) => id === "profile.data.snapshots"),
  ).toHaveLength(1)
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install(first)
  const pin = SnapshotPin.make(tmp.path)
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const body = { entered: false }
  const gate = coordinateNativeRoots([{ kind: "json", path: tmp.path }], async () => {
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
  })
  const held = gate.then(
    () => undefined,
    (err) => err,
  )
  await Effect.runPromise(Deferred.await(entered))
  const work = Effect.runPromise(
    pin.run(
      port,
      Effect.promise(async () => {
        body.entered = true
        await writeFile(path.join(tmp.path, "actual.txt"), "actual admitted Snapshot Git")
        await git(tmp.path, "add", "actual.txt")
        return git(tmp.path, "write-tree")
      }),
    ),
  )
  const observed = work.then(
    () => "done",
    () => "failed",
  )
  expect(await Promise.race([observed, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  expect(body.entered).toBe(false)
  expect((await Effect.runPromise(ProfileWriterLive.snapshot)).active).toContainEqual({
    id: "profile.data.snapshots",
    count: 1,
  })
  const drain = Effect.runPromise(runtime.close())
  const retired = drain.then(
    () => "done",
    () => "failed",
  )
  expect(await Promise.race([retired, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await held).toBeUndefined()
  expect(await work).toMatch(/^[0-9a-f]{40}$/)
  await drain
  expect(
    (await Effect.runPromise(ProfileWriterLive.snapshot)).active.filter((row) => row.id === "profile.data.snapshots"),
  ).toEqual([])
})

test("only explicit data-covered bootstrap creates absent repository and never resets an established generation", async () => {
  const root = await mkdtemp(path.join(Global.Path.data, "snapshot-pin-"))
  try {
    const dir = path.join(root, "project", "repository")
    const pin = SnapshotPin.make(dir)
    const runtime = SnapshotRuntime.make(createShutdown())
    const port = runtime.install()
    const body = { entered: false }
    await rejects(
      Effect.runPromise(
        pin.run(
          port,
          Effect.sync(() => {
            body.entered = true
          }),
        ),
      ),
      /ENOENT/,
    )
    expect(body.entered).toBe(false)
    // The first failure belongs to its own deliberately refusing controller.
    const clean = SnapshotRuntime.make(createShutdown())
    const owned = clean.install()
    expect(
      await Effect.runPromise(
        pin.bootstrap(
          owned,
          Effect.promise(async () => {
            await git(dir, "init")
            await writeFile(path.join(dir, "initial.txt"), "owned initial generation")
            await git(dir, "add", "initial.txt")
            return git(dir, "write-tree")
          }),
        ),
      ),
    ).toMatch(/^[0-9a-f]{40}$/)
    await rename(dir, `${dir}.original`)
    await mkdir(dir)
    await git(dir, "init")
    await rejects(
      Effect.runPromise(
        pin.bootstrap(
          owned,
          Effect.sync(() => {
            body.entered = true
          }),
        ),
      ),
      /generation changed/,
    )
    expect(body.entered).toBe(false)
    await rejects(Effect.runPromise(clean.close()), (err: unknown) =>
      flattened(err).some((cause) => cause instanceof Error && cause.message.includes("generation changed")),
    )
    await rejects(Effect.runPromise(runtime.close()), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("retained repository pin refuses canonical alias rebinding before another actual Git operation", async () => {
  await using tmp = await tmpdir({ git: true })
  const one = path.join(tmp.path, "one")
  const two = path.join(tmp.path, "two")
  const alias = path.join(tmp.path, "alias")
  await mkdir(one)
  await mkdir(two)
  await git(one, "init")
  await git(two, "init")
  await symlink(one, alias, process.platform === "win32" ? "junction" : "dir")
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const pin = SnapshotPin.make(alias)
  await Effect.runPromise(
    pin.run(
      port,
      Effect.promise(() => git(alias, "write-tree")),
    ),
  )
  await rm(alias)
  await symlink(two, alias, process.platform === "win32" ? "junction" : "dir")
  const body = { entered: false }
  await rejects(
    Effect.runPromise(
      pin.run(
        port,
        Effect.sync(() => {
          body.entered = true
        }),
      ),
    ),
    /generation changed/,
  )
  expect(body.entered).toBe(false)
  await rejects(Effect.runPromise(runtime.close()), /generation changed/)
})

test("failed actual body and detected repository replacement both survive postcheck and lease retirement", async () => {
  await using tmp = await tmpdir({ git: true })
  const dir = path.join(tmp.path, "repository")
  await mkdir(dir)
  await git(dir, "init")
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const pin = SnapshotPin.make(dir)
  const error = new Error("Actual body failed after filesystem replacement")
  await rejects(
    Effect.runPromise(
      pin.run(
        port,
        Effect.promise(async () => {
          await git(dir, "write-tree")
          await rename(dir, `${dir}.original`)
          await mkdir(dir)
          throw error
        }),
      ),
    ),
    (err: unknown) => {
      const failures = flattened(err)
      expect(failures).toContain(error)
      expect(failures.some((cause) => cause instanceof Error && cause.message.includes("generation changed"))).toBe(
        true,
      )
      return true
    },
  )
  await rejects(Effect.runPromise(runtime.close()))
})

test("owned cancellation still performs uninterruptible pin postcheck and retains a replaced repository failure", async () => {
  await using tmp = await tmpdir({ git: true })
  const dir = path.join(tmp.path, "repository")
  await mkdir(dir)
  await git(dir, "init")
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const pin = SnapshotPin.make(dir)
  const started = Deferred.makeUnsafe<void>()
  const fiber = await Effect.runPromise(
    port.launch(
      { namespaces: [tmp.path] },
      pin.run(
        port,
        Effect.promise(() => git(dir, "write-tree")).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.promise(async () => {
              await rename(dir, `${dir}.original`)
              await mkdir(dir)
            }),
          ),
        ),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(started))
  await Effect.runPromise(port.cancel(fiber))
  await rejects(Effect.runPromise(runtime.close()), (err: unknown) => {
    expect(flattened(err).some((cause) => cause instanceof Error && cause.message.includes("generation changed"))).toBe(
      true,
    )
    return true
  })
  expect(runtime.snapshot().controller?.active).toBe(0)
})
