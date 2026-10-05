import { expect, test } from "bun:test"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import path from "node:path"
import { Database } from "../../../src/database/database"
import {
  databaseSnapshot,
  drainDatabase,
  drainDatabases,
  openDatabase,
  prepareDatabase,
  resumeDatabase,
} from "../../../src/kilocode/profile-database"
import { tmpdir } from "../../fixture/tmpdir"

test("real native roots retire terminally without creating an unknown or unused database", async () => {
  await using dir = await tmpdir()
  const mode = process.env.RAYA_TEST_DATABASE_TERMINAL
  const file = path.join(dir.path, "first.db")
  const peer = path.join(dir.path, "second.db")
  const unused = path.join(dir.path, "unused.db")
  const unknown = path.join(dir.path, "unknown", "sessions.db")
  const alias = path.join(dir.path, ".", "first.db")
  const first = ManagedRuntime.make(Database.layerFromPath(file).pipe(Layer.fresh))
  const second = ManagedRuntime.make(Database.layerFromPath(peer).pipe(Layer.fresh))
  const lazy = ManagedRuntime.make(Database.layerFromPath(unused).pipe(Layer.fresh))
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  class Failure extends Context.Service<Failure, void>()("@test/TerminalNativeFailure") {}
  const failed = ManagedRuntime.make(
    Layer.effect(
      Failure,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(new Error("actual terminal finalizer failed")))
      }),
    ),
  )
  try {
    await first.runPromise(Database.Service.use((s) => s.db.run("CREATE TABLE terminal_test(value TEXT)")))
    await second.runPromise(Database.Service.use((s) => s.db.get("SELECT 1")))
    if (mode === "failed") await failed.runPromise(Failure.use(() => Effect.void))
    const transaction = first.runPromise(
      Database.Service.use((s) =>
        s.db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run("INSERT INTO terminal_test VALUES ('before')")
            started.resolve()
            yield* Effect.promise(() => release.promise)
            yield* tx.run("INSERT INTO terminal_test VALUES ('after')")
          }),
        ),
      ),
    )
    await started.promise
    const overlapping =
      mode === "overlap"
        ? drainDatabase(peer, async () => {
            await transaction
            await second.dispose()
            throw new Error("cooperative drain failed")
          })
        : undefined
    void overlapping?.catch(() => undefined) // Its failure is asserted through the terminal joined drain below.
    let calls = 0
    const closed = drainDatabases(async () => {
      calls += 1
      expect(databaseSnapshot(file).phase).toBe("draining")
      expect(databaseSnapshot(peer).phase).toBe("draining")
      expect(databaseSnapshot(unused).phase).toBe("draining")
      await transaction
      const results = await Promise.allSettled([
        first.dispose(),
        ...(mode === "remaining" ? [] : [second.dispose()]),
        lazy.dispose(),
        failed.dispose(),
      ])
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) throw new AggregateError(failures, "Actual scope finalization failed")
    })
    const result = closed.catch((err: unknown) => err)
    expect(calls).toBe(1)
    expect(drainDatabases(() => Promise.reject(new Error("duplicate callback")))).toBe(closed)
    expect(() => Database.layerFromPath(alias)).toThrow("admission is terminal")
    expect(() => Database.layerFromPath(unknown)).toThrow("admission is terminal")
    expect(() => prepareDatabase(unknown, () => Bun.write(unknown, "forbidden"))).toThrow("admission is terminal")
    expect(() => openDatabase(unknown, () => ({}))).toThrow("admission is terminal")
    expect(() => resumeDatabase(file)).toThrow("admission is terminal")
    expect((await lazy.runPromiseExit(Database.Service.use((s) => s.db.get("SELECT 1"))))._tag).toBe("Failure")
    expect(databaseSnapshot(file).instances).toHaveLength(1)
    expect(databaseSnapshot(peer).instances).toHaveLength(1)
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    const receipt = await result
    expect(calls).toBe(1)
    expect(await Bun.file(unused).exists()).toBe(false)
    expect(await Bun.file(unknown).exists()).toBe(false)
    expect(databaseSnapshot(file).instances).toHaveLength(0)
    expect(databaseSnapshot(unused).instances).toHaveLength(0)
    if (mode === "joined") {
      expect(receipt).toMatchObject({
        format: "raya.database-terminal",
        processLocal: true,
        portableCaptureAuthorized: false,
      })
      expect(databaseSnapshot(peer)).toMatchObject({ phase: "closed", instances: [] })
      const { Database: Native } = await import("bun:sqlite")
      using native = new Native(file, { readonly: true })
      expect(native.query("SELECT value FROM terminal_test ORDER BY rowid").all()).toEqual([
        { value: "before" },
        { value: "after" },
      ])
      return
    }
    expect(receipt).toBeInstanceOf(AggregateError)
    if (!(receipt instanceof AggregateError)) throw receipt
    expect(String(receipt.errors[0])).toContain(
      mode === "failed"
        ? "Actual scope finalization failed"
        : mode === "overlap"
          ? "cooperative drain failed"
          : "left registered instances",
    )
    expect(databaseSnapshot(file).phase).toBe("refused")
    expect(databaseSnapshot(peer).phase).toBe("refused")
    expect(databaseSnapshot(peer).instances).toHaveLength(mode === "remaining" ? 1 : 0)
    await second.dispose()
    expect(databaseSnapshot(peer).instances).toHaveLength(0)
    expect(databaseSnapshot(peer).phase).toBe("refused")
    expect(await drainDatabases(() => Promise.resolve()).catch((err: unknown) => err)).toBe(receipt)
    expect(() => resumeDatabase(peer)).toThrow("admission is terminal")
  } finally {
    release.resolve()
    await Promise.allSettled([first.dispose(), second.dispose(), lazy.dispose(), failed.dispose()])
  }
}, 30_000)
