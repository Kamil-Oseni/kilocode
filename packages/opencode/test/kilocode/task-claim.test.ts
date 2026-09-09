import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { claim } from "@/kilocode/task/claim"
import { inspect, recover } from "@/kilocode/task/recovery"
import { Storage } from "@/storage/storage"
import { owner, stopped } from "@/kilocode/task/owner"
import { SessionID } from "@/session/schema"
import { publish } from "@/kilocode/session/review-publish"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))

function store(fs: FSUtil.Interface, directory: string) {
  const file = (key: string[]) => path.join(directory, ...key) + ".json"
  return {
    read: (key: string[]) =>
      fs.readFileString(file(key)).pipe(
        Effect.mapError((error) =>
          error.reason._tag === "NotFound" ? new Storage.NotFoundError({ message: "missing" }) : error,
        ),
        Effect.map((value): unknown => JSON.parse(value)),
      ),
    create: (key: string[], value: unknown) => publish(fs, file(key), value),
    replace: (key: string[], value: unknown) => publish(fs, file(key), value, true).pipe(Effect.asVoid),
    remove: (key: string[]) => fs.remove(file(key)),
  }
}

describe("routine startup claims", () => {
  it.live("claim inspection withholds malformed and cross-routine identities without modifying evidence", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const directory = yield* tmpdirScoped()
      const storage = store(fs, directory)
      const key = ["raya", "agent-claims", createHash("sha256").update("routine").digest("hex")]
      const record = {
        version: 1,
        agentID: "another",
        id: "run",
        at: 1234,
        phase: "session-created",
        sessionID: "ses_saved",
        owner: owner(),
      }
      for (const value of [{ version: 1 }, record]) {
        yield* storage.replace(key, value)
        expect(yield* inspect(storage, "routine")).toEqual({ state: "recovery" })
        expect(yield* storage.read(key)).toEqual(value)
      }
      yield* storage.replace(key, { ...record, agentID: "routine" })
      expect(yield* inspect(storage, "routine")).toEqual({
        state: "recovery",
        runID: "run",
        sessionID: SessionID.make("ses_saved"),
      })
      expect(yield* inspect({ ...storage, read: () => Effect.die("unreadable") }, "routine")).toEqual({
        state: "recovery",
      })
      const cancelled = yield* inspect({ ...storage, read: () => Effect.interrupt }, "routine").pipe(Effect.exit)
      expect(Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause)).toBe(true)
    }),
  )
  it.live("a trigger-evidence write failure prevents session creation and retains ownership", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const directory = yield* tmpdirScoped()
      const storage = store(fs, directory)
      const starts: string[] = []
      const result = yield* claim(
        { ...storage, replace: () => Effect.die("evidence write failed") },
        "routine",
        Effect.void,
        () => Effect.sync(() => starts.push("started")),
        () => ({ kind: "manual" }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(starts).toEqual([])
      expect((yield* claim(storage, "routine", Effect.void, () => Effect.void).pipe(Effect.flip))._tag).toBe(
        "RayaTask.GuardError",
      )
    }),
  )
  test("live, foreign, legacy, and malformed owners never prove a stopped backend", () => {
    const current = owner()
    expect(stopped(current)).toBe(false)
    for (const value of [
      undefined,
      null,
      {},
      { pid: current.pid },
      { ...current, host: `${current.host}-foreign` },
      { ...current, pid: 0 },
      { ...current, pid: -1 },
      { ...current, pid: 1.5 },
      { ...current, pid: "123" },
    ]) {
      expect(stopped(value)).toBe(false)
    }
  })

  it.live(
    "a failed session-link write prevents later startup and preserves the original claim",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        const storage = store(fs, directory)
        const steps: string[] = []
        const failed = yield* claim(
          { ...storage, replace: () => Effect.die("link write failed") },
          "routine",
          Effect.void,
          (_, owner) =>
            Effect.gen(function* () {
              yield* owner.link(SessionID.make("ses_created"))
              steps.push("goal")
            }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(steps).toEqual([])
        const files = yield* fs.glob("**/*.json", { cwd: directory })
        expect(files).toHaveLength(1)
        expect(yield* fs.readJson(path.join(directory, files[0]))).toMatchObject({ version: 1, phase: "claimed" })
        expect((yield* claim(storage, "routine", Effect.void, () => Effect.void).pipe(Effect.flip))._tag).toBe(
          "RayaTask.GuardError",
        )
      }),
    30_000,
  )

  it.live(
    "retains the created session identity when later startup work fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        const sessionID = SessionID.make("ses_created")
        const trigger = { kind: "timer" as const, id: "occurrence", scheduledAt: 1000, observedAt: 2000 }
        const ids: string[] = []
        const failed = yield* claim(
          store(fs, directory),
          "routine",
          Effect.void,
          (_, owner) =>
            Effect.gen(function* () {
              ids.push(owner.id)
              yield* owner.link(sessionID)
              return yield* Effect.die("goal persistence failed")
            }),
          () => trigger,
        ).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        const files = yield* fs.glob("**/*.json", { cwd: directory })
        expect(files).toHaveLength(1)
        expect(yield* fs.readJson(path.join(directory, files[0]))).toMatchObject({
          version: 1,
          agentID: "routine",
          id: ids[0],
          phase: "session-created",
          sessionID,
          trigger,
        })
        expect(
          (yield* claim(store(fs, directory), "routine", Effect.void, () => Effect.die("must not repeat")).pipe(
            Effect.flip,
          ))._tag,
        ).toBe("RayaTask.GuardError")
      }),
    30_000,
  )

  it.live(
    "separate processes cannot repeat an uncertain routine start",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* tmpdirScoped()
        const fixture = fileURLToPath(new URL("./fixtures/task-claim.ts", import.meta.url))
        const results = yield* Effect.all(
          Array.from({ length: 3 }, (_, owner) =>
            spawner.exitCode(
              ChildProcess.make(process.execPath, [fixture, directory, String(owner)], {
                stdin: "ignore",
                detached: false,
              }),
            ),
          ),
          { concurrency: 3 },
        )
        expect(results.filter((code) => code === 20)).toHaveLength(1)
        expect(results.filter((code) => code === 10)).toHaveLength(2)
        const files = yield* fs.glob("**/*.json", { cwd: directory })
        const record = yield* fs.readJson(path.join(directory, files[0]))
        expect(
          stopped(typeof record === "object" && record !== null && "owner" in record ? record.owner : undefined),
        ).toBe(true)
        const denied = yield* claim(store(fs, directory), "routine", Effect.void, () =>
          Effect.die("must not repeat"),
        ).pipe(Effect.flip)
        expect(denied.message).toContain("previous backend has stopped")
        expect(yield* recover(store(fs, directory), "routine", () => Effect.succeed(false))).toBe(false)
        expect(
          Number(
            yield* spawner.exitCode(
              ChildProcess.make(process.execPath, [fixture, directory, "crash", "recover-crash"], {
                stdin: "ignore",
                detached: false,
              }),
            ),
          ),
        ).toBe(21)
        const recovery = yield* Effect.all(
          Array.from({ length: 3 }, (_, owner) =>
            spawner.exitCode(
              ChildProcess.make(process.execPath, [fixture, directory, String(owner), "recover"], {
                stdin: "ignore",
                detached: false,
              }),
            ),
          ),
          { concurrency: 3 },
        )
        expect(recovery.filter((code) => code === 0)).toHaveLength(1)
        expect(recovery.filter((code) => code === 10)).toHaveLength(2)
        expect(yield* claim(store(fs, directory), "routine", Effect.void, () => Effect.succeed("new run"))).toBe(
          "new run",
        )
        // A delayed recovery must not remove a newer startup at the same storage path.
        yield* fs.writeJson(path.join(directory, files[0]), record)
        const observed = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const stale = yield* recover(store(fs, directory), "routine", () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(observed, undefined)
            yield* Deferred.await(release)
            return true
          }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(observed)
        yield* Effect.gen(function* () {
          expect(yield* recover(store(fs, directory), "routine", () => Effect.succeed(true))).toBe(true)
          yield* claim(store(fs, directory), "routine", Effect.void, () => Effect.die("new uncertain start")).pipe(
            Effect.exit,
          )
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        expect(yield* Fiber.join(stale)).toBe(false)
        expect(yield* recover(store(fs, directory), "routine", () => Effect.succeed(true))).toBe(false)
        expect(yield* fs.readJson(path.join(directory, files[0]))).not.toEqual(record)
        expect(yield* fs.readFileString(path.join(directory, "started.txt"))).toBe(
          String(results.findIndex((code) => code === 20)),
        )
      }),
    30_000,
  )

  it.live(
    "independent storage adapters exclude competing starts and release after success",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        const entered = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const first = yield* claim(store(fs, directory), "routine", Effect.succeed("checked"), (value, owner) =>
          Effect.gen(function* () {
            expect(value).toBe("checked")
            expect(owner.id).toMatch(/^[0-9a-f-]{36}$/)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(finish)
            return "started"
          }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const results = yield* Effect.all(
          Array.from({ length: 8 }, () =>
            claim(store(fs, directory), "routine", Effect.die("competing check ran"), () =>
              Effect.die("competing start ran"),
            ).pipe(Effect.flip),
          ),
          { concurrency: 8 },
        )
        expect(results.every((result) => result._tag === "RayaTask.GuardError")).toBe(true)
        yield* Deferred.succeed(finish, undefined)
        expect(yield* Fiber.join(first)).toBe("started")
        expect(yield* claim(store(fs, directory), "routine", Effect.void, () => Effect.succeed("next"))).toBe("next")
      }),
    30_000,
  )

  it.live(
    "failed read-only checks release claims but interrupted starts retain them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        const storage = store(fs, directory)
        expect(
          yield* claim(storage, "routine", Effect.fail("paused"), () => Effect.die("must not start")).pipe(Effect.flip),
        ).toBe("paused")
        expect(yield* inspect(storage, "routine")).toBeUndefined()
        const entered = yield* Deferred.make<void>()
        const first = yield* claim(storage, "routine", Effect.void, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.never
          }),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const live = yield* inspect(storage, "routine")
        expect(live?.state).toBe("starting")
        if (!live || !("runID" in live)) throw new Error("Expected live startup identity")
        expect(live.runID).toBeTruthy()
        yield* Fiber.interrupt(first)
        expect(yield* inspect(storage, "routine")).toEqual({ state: "recovery", runID: live.runID })
        const result = yield* claim(store(fs, directory), "routine", Effect.void, () =>
          Effect.die("must not repeat"),
        ).pipe(Effect.flip)
        expect(result._tag).toBe("RayaTask.GuardError")
        expect(result.message).toContain("awaiting recovery")
        const files = yield* fs.glob("**/*.json", { cwd: directory })
        expect(files).toHaveLength(1)
        expect(yield* fs.readJson(path.join(directory, files[0]))).toMatchObject({ version: 1, agentID: "routine" })
      }),
    30_000,
  )

  it.live(
    "a startup defect retains ownership while unrelated routines remain independent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        const storage = store(fs, directory)
        const failed = yield* claim(storage, "routine", Effect.void, () =>
          Effect.die("session persistence failed"),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(
          (yield* claim(store(fs, directory), "routine", Effect.void, () => Effect.void).pipe(Effect.flip))._tag,
        ).toBe("RayaTask.GuardError")
        expect(yield* claim(storage, "other", Effect.void, () => Effect.succeed("independent"))).toBe("independent")
      }),
    30_000,
  )
})
