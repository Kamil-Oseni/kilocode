import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "node:path"
import { Database } from "../../src/database/database"
import { databaseSnapshot, drainDatabase, resumeDatabase } from "../../src/kilocode/profile-database"
import { tmpdir } from "../fixture/tmpdir"

function runtime(file: string) {
  return ManagedRuntime.make(Database.layerFromPath(file).pipe(Layer.fresh))
}

describe("Core database service lifecycle", () => {
  test("real Node service graphs confirm exact closure and reopen preserved rows", async () => {
    await using dir = await tmpdir()
    const built = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/profile-database-node-worker.ts")],
      target: "node",
      format: "esm",
    })
    expect(built.success).toBe(true)
    const bundle = path.join(dir.path, "worker.mjs")
    await Bun.write(bundle, built.outputs[0]!)
    const child = Bun.spawn(["node", bundle, path.join(dir.path, "sessions.db")], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const code = await child.exited
      const [stdout, stderr] = await output
      expect(code, stdout + stderr).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.receipt).toMatchObject({
        status: "confirmed",
        instances: 2,
        processLocal: true,
        portableCaptureAuthorized: false,
      })
      expect(result.rows).toEqual([{ value: "preserved" }, { value: "peer" }])
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
      await output
    }
  }, 60_000)

  test("drains two independent service graphs after their transaction settles and fences new acquisition", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "sessions.db")
    const first = runtime(file)
    const second = runtime(file)
    const waiting = runtime(file)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      await first.runPromise(Database.Service.use((s) => s.db.run("CREATE TABLE lifecycle_test (value TEXT)")))
      await second.runPromise(Database.Service.use((s) => s.db.get("SELECT count(*) AS count FROM lifecycle_test")))
      expect(databaseSnapshot(file).instances).toHaveLength(2)
      const transaction = first.runPromise(
        Database.Service.use((s) =>
          s.db.transaction(
            (tx) =>
              Effect.gen(function* () {
                yield* tx.run("INSERT INTO lifecycle_test VALUES ('before')")
                started.resolve()
                yield* Effect.promise(() => release.promise)
                yield* tx.run("INSERT INTO lifecycle_test VALUES ('after')")
              }),
            { behavior: "immediate" },
          ),
        ),
      )
      await started.promise
      const receipt = drainDatabase(file, async () => {
        await transaction
        await Promise.all([first.dispose(), second.dispose()])
      })
      expect(
        drainDatabase(file, async () => {
          throw new Error("duplicate disposal")
        }),
      ).toBe(receipt)
      expect(databaseSnapshot(file).phase).toBe("draining")
      expect(databaseSnapshot(file).instances).toHaveLength(2)
      expect(() => runtime(path.join(dir.path, ".", "sessions.db"))).toThrow("Database service acquisition is draining")
      const late = await waiting.runPromiseExit(Database.Service.use((s) => s.db.get("SELECT 1")))
      expect(late._tag).toBe("Failure")
      expect(databaseSnapshot(file).instances).toHaveLength(2)
      release.resolve()
      expect(await receipt).toMatchObject({
        status: "confirmed",
        instances: 2,
        processLocal: true,
        portableCaptureAuthorized: false,
      })
      expect(databaseSnapshot(file)).toMatchObject({ phase: "closed", instances: [] })
      expect(() => runtime(file)).toThrow("Database service acquisition is closed")
      resumeDatabase(file)
      const fresh = runtime(file)
      try {
        const rows = await fresh.runPromise(
          Database.Service.use((s) => s.db.all<{ value: string }>("SELECT value FROM lifecycle_test ORDER BY rowid")),
        )
        expect(rows).toEqual([{ value: "before" }, { value: "after" }])
      } finally {
        await fresh.dispose()
      }
    } finally {
      release.resolve()
      await Promise.all([first.dispose(), second.dispose(), waiting.dispose()])
    }
  }, 30_000)

  test("refuses a disposal receipt that leaves an independently compiled service alive", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "sessions.db")
    const first = runtime(file)
    const second = runtime(file)
    try {
      await first.runPromise(Database.Service.use((s) => s.db.get("SELECT 1")))
      await second.runPromise(Database.Service.use((s) => s.db.get("SELECT 1")))
      const err = await drainDatabase(file, () => first.dispose()).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(err instanceof Error ? err.message : "").toBe("Database service disposal left registered instances")
      expect(databaseSnapshot(file)).toMatchObject({ phase: "refused" })
      expect(databaseSnapshot(file).instances).toHaveLength(1)
      expect(() => runtime(file)).toThrow("Database service acquisition is refused")
      expect(() => resumeDatabase(file)).toThrow("Database lifecycle is not confirmed closed")
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
    }
    expect(databaseSnapshot(file).instances).toHaveLength(0)
    expect(databaseSnapshot(file).phase).toBe("refused")
  }, 30_000)

  test("an unconfirmed disposal deadline keeps acquisition fenced even after late closure", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "sessions.db")
    const current = runtime(file)
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    try {
      await current.runPromise(Database.Service.use((s) => s.db.get("SELECT 1")))
      const err = await drainDatabase(
        file,
        async () => {
          await release.promise
          await current.dispose()
          finished.resolve()
        },
        20,
      ).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(err instanceof Error ? err.message : "").toBe(
        "Database service disposal was not confirmed before deadline",
      )
      expect(databaseSnapshot(file).phase).toBe("refused")
      expect(() => runtime(file)).toThrow("Database service acquisition is refused")
      release.resolve()
      await finished.promise
      expect(databaseSnapshot(file).instances).toHaveLength(0)
      expect(() => resumeDatabase(file)).toThrow("Database lifecycle is not confirmed closed")
    } finally {
      release.resolve()
      await current.dispose()
    }
  }, 30_000)

  test("failed initialization finalizes its exact native instance", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "sessions.db")
    const { Database: Native } = await import("bun:sqlite")
    const native = new Native(file)
    native.run("CREATE TABLE unrelated (value TEXT)")
    native.close()
    const current = runtime(file)
    try {
      const exit = await current.runPromiseExit(Database.Service.use((s) => s.db.get("SELECT 1")))
      expect(exit._tag).toBe("Failure")
    } finally {
      await current.dispose()
    }
    expect(databaseSnapshot(file).instances).toHaveLength(0)
  }, 30_000)
})
