import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect } from "effect"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SnapshotRuntime } from "../../src/kilocode/snapshot/runtime"
import { KiloSnapshotTrack } from "../../src/kilocode/snapshot/track"
import { createShutdown } from "../../src/kilocode/cli/shutdown"
import { ProfileWriterRegistry } from "../../src/kilocode/migration/writer-registry"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { SessionID, MessageID } from "../../src/session/schema"
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

async function setup() {
  const registry = ProfileWriterRegistry.make(["profile.data.snapshots"])
  await Effect.runPromise(registry.register("profile.data.snapshots"))
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install(ProfileWriterLive.from(registry, "profile.data.snapshots"))
  return { registry, runtime, port }
}

test("owned optional track return retains actual gated Git finalizer and registry until drain", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = await setup()
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const finalized = Deferred.makeUnsafe<void>()
  const index = path.join(tmp.path, ".git", "index")
  const gate = coordinateNativeRoots([{ kind: "json", path: index }], async () => {
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
  })
  const held = gate.then(
    () => undefined,
    (err) => err,
  )
  await Effect.runPromise(Deferred.await(entered))
  const input = { namespaces: [tmp.path] }
  const inner = Deferred.succeed(finalized, undefined).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(
      state.port
        .run(
          { namespaces: [tmp.path], targets: [index] },
          Effect.promise(async () => {
            await writeFile(path.join(tmp.path, "retained.txt"), "real accepted cleanup")
            await git(tmp.path, "add", "retained.txt")
          }),
        )
        .pipe(Effect.orDie),
    ),
  )
  const result = await Effect.runPromise(
    KiloSnapshotTrack.protect({
      ownership: state.port,
      input,
      state: KiloSnapshotTrack.makeState(),
      operation: "track",
      fallback: undefined,
      timeoutMs: 40,
      inner: KiloSnapshotTrack.wrap({
        ownership: state.port,
        input,
        state: KiloSnapshotTrack.makeState(),
        timeoutMs: 10,
        inner,
      }),
    }),
  )
  expect(result).toBeUndefined()
  await Effect.runPromise(Deferred.await(finalized))
  expect((await Effect.runPromise(state.registry.snapshot)).active).toEqual([
    { id: "profile.data.snapshots", count: 1 },
  ])
  const drain = Effect.runPromise(state.runtime.close())
  const settled = drain.then(
    () => "done",
    () => "failed",
  )
  expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await held).toBeUndefined()
  await drain
  expect(await git(tmp.path, "ls-files", "retained.txt")).toBe("retained.txt")
  expect((await Effect.runPromise(state.registry.snapshot)).active).toEqual([])
  expect(state.runtime.snapshot().controller).toMatchObject({ active: 0, failures: 0 })
})

test("successful owned protect and wrap release use harmless exact settled cancellation", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = await setup()
  const input = { namespaces: [tmp.path] }
  const result = await Effect.runPromise(
    KiloSnapshotTrack.protect({
      ownership: state.port,
      input,
      state: KiloSnapshotTrack.makeState(),
      operation: "track",
      fallback: undefined,
      inner: KiloSnapshotTrack.wrap({
        ownership: state.port,
        input,
        state: KiloSnapshotTrack.makeState(),
        inner: Effect.promise(() => git(tmp.path, "write-tree")),
      }),
    }),
  )
  expect(result).toMatch(/^[0-9a-f]{40}$/)
  await Effect.runPromise(state.runtime.close())
  expect(state.runtime.snapshot().controller).toMatchObject({ active: 0, failures: 0, cancelled: 0 })
})

test("owned compatibility fallback retains actual filesystem body and finalizer failures", async () => {
  await using tmp = await tmpdir({ git: true })
  for (const finalizer of [false, true]) {
    const state = await setup()
    const work = Effect.promise(() => writeFile(path.join(tmp.path, "missing", "failure.txt"), "must fail"))
    const inner = finalizer ? Effect.never.pipe(Effect.ensuring(work)) : work.pipe(Effect.as(undefined))
    expect(
      await Effect.runPromise(
        KiloSnapshotTrack.protect({
          ownership: state.port,
          input: { namespaces: [tmp.path] },
          state: KiloSnapshotTrack.makeState(),
          operation: "patch",
          fallback: undefined,
          timeoutMs: 15,
          inner,
        }),
      ),
    ).toBeUndefined()
    await rejects(Effect.runPromise(state.runtime.close()), /ENOENT/)
    expect(state.runtime.snapshot().controller?.failures).toBeGreaterThan(0)
    expect((await Effect.runPromise(state.registry.snapshot)).active).toEqual([])
  }
})

test("owned progress publication and cleanup retain actual filesystem failures before fallback", async () => {
  await using tmp = await tmpdir({ git: true })
  const state = await setup()
  const start = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const hooks: KiloSnapshotTrack.Hooks = {
    ask: async () => {
      throw new Error("Unexpected interactive request")
    },
    persistDisable: () => writeFile(path.join(tmp.path, "disabled.txt"), "disabled"),
    startProgress: async () => {
      await writeFile(path.join(tmp.path, "progress.txt"), "actual publication")
      await Effect.runPromise(Deferred.succeed(start, undefined))
      await Effect.runPromise(Deferred.await(release))
    },
    updateProgress: () => writeFile(path.join(tmp.path, "progress.txt"), "actual update"),
    endProgress: () => writeFile(path.join(tmp.path, "missing", "progress.txt"), "actual failed removal"),
  }
  const input = { namespaces: [tmp.path] }
  const value = await Effect.runPromise(
    KiloSnapshotTrack.protect({
      ownership: state.port,
      input,
      state: KiloSnapshotTrack.makeState(),
      operation: "track",
      fallback: undefined,
      timeoutMs: 40,
      inner: KiloSnapshotTrack.wrap({
        ownership: state.port,
        input,
        state: KiloSnapshotTrack.makeState(),
        snapshotInitialization: "wait",
        hooks,
        sessionID: SessionID.make("ses_progress_owned"),
        messageID: MessageID.ascending(),
        progressDelayMs: 1,
        timeoutMs: 5,
        inner: Deferred.await(start).pipe(Effect.as("actual")),
      }),
    }),
  )
  expect(value).toBeUndefined()
  expect(await Bun.file(path.join(tmp.path, "progress.txt")).text()).toBe("actual publication")
  const drain = Effect.runPromise(state.runtime.close())
  const settled = drain.then(
    () => "done",
    () => "failed",
  )
  expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  expect((await Effect.runPromise(state.registry.snapshot)).active).toHaveLength(1)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await rejects(drain, (err: unknown) => {
    expect(err).toBeInstanceOf(AggregateError)
    if (!(err instanceof AggregateError)) return false
    expect(err.errors.some((cause: unknown) => cause instanceof Error && cause.message.includes("ENOENT"))).toBe(true)
    expect(
      err.errors.every((cause: unknown) => cause instanceof Error && !cause.message.includes("All fibers interrupted")),
    ).toBe(true)
    return true
  })
  expect((await Effect.runPromise(state.registry.snapshot)).active).toEqual([])
})
