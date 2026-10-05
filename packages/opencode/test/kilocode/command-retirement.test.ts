import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { openDatabase, closeDatabase, databaseSnapshot } from "@opencode-ai/core/kilocode/profile-database"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"
import { createRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { retireHandler } from "../../src/kilocode/server/httpapi/retirement"
import { admission } from "../../src/kilocode/task/admission"
import { EffectBridge } from "../../src/effect/bridge"
import { retireCommand } from "../../src/kilocode/cli/command-retirement"

test("a realized embedded HTTP owner joins its native SQLite finalizer through the runtime registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-command-http-"))
  const file = join(root, "state.db")
  const registry = createRegistry()
  const routes = HttpRouter.use((router) =>
    router.add("GET", "/", Effect.succeed(HttpServerResponse.text("ready"))),
  ).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const native = openDatabase(file, (file) => profileSqlite(file, (file) => new Database(file)))
          native.run("CREATE TABLE witness(value TEXT)")
          native.run("INSERT INTO witness VALUES ('actual')")
          yield* Effect.addFinalizer(() => Effect.promise(() => closeDatabase(native)))
        }),
      ),
    ),
  )
  const app = retireHandler(HttpRouter.toWebHandler(routes, { disableLogger: true }), registry)
  try {
    expect(await (await app.handler(new Request("http://localhost/"))).text()).toBe("ready")
    expect(databaseSnapshot(file).instances.length).toBe(1)
    await registry.drain()
    expect(databaseSnapshot(file).instances).toEqual([])
    await assert.rejects(app.handler(new Request("http://localhost/")), /retired/)
  } finally {
    await app.dispose()
    assert.equal(resolve(dirname(root)), resolve(tmpdir()))
    assert(basename(root).startsWith("raya-command-http-"))
    await rm(root, { recursive: true })
  }
})

test("command cleanup joins a genuine scheduled callback and native finalizer before closing its scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-command-callback-"))
  const file = join(root, "state.db")
  const native = openDatabase(file, (file) => profileSqlite(file, (file) => new Database(file)))
  native.run("CREATE TABLE witness(value TEXT)")
  const scope = Scope.makeUnsafe()
  const gate = admission()
  const bridge = Effect.runSync(EffectBridge.make())
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const state = { wrote: false, finalized: false }
  gate.dispatch(
    Effect.promise(async () => {
      entered.resolve()
      await release.promise
      native.run("INSERT INTO witness VALUES ('actual')")
      state.wrote = true
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await closeDatabase(native)
          state.finalized = true
        }),
      ),
    ),
    scope,
    bridge.fork,
  )
  await entered.promise
  const closing = retireCommand(() => Effect.runPromise(Scope.close(scope, Exit.void)), gate.quiesce)
  release.resolve()
  try {
    await closing
    expect(state).toEqual({ wrote: true, finalized: true })
    expect(gate.snapshot()).toMatchObject({ closed: true, active: 0, failures: 0 })
    expect(databaseSnapshot(file).instances).toEqual([])
  } finally {
    release.resolve()
    await Promise.allSettled([closing, gate.quiesce(), Effect.runPromise(Scope.close(scope, Exit.void))])
    assert.equal(resolve(dirname(root)), resolve(tmpdir()))
    assert(basename(root).startsWith("raya-command-callback-"))
    await rm(root, { recursive: true })
  }
})

test("command cleanup preserves genuine interruption and a later disposal failure", async () => {
  const gate = admission()
  await Effect.runPromiseExit(gate.track(Effect.interrupt, () => "closed"))
  const failure = new Error("disposal failed")
  const result = await Promise.allSettled([retireCommand(() => Promise.reject(failure), gate.quiesce)])
  expect(result[0].status).toBe("rejected")
  if (result[0].status !== "rejected") throw new Error("Original failures were lost")
  expect(result[0].reason).toBeInstanceOf(AggregateError)
  expect(result[0].reason.errors[0].message).toBe("Scheduler work could not be confirmed settled")
  expect(result[0].reason.errors[1]).toBe(failure)
  expect(gate.snapshot()).toMatchObject({ closed: true, active: 0, failures: 1 })
})

test("registry retirement leaves an unused HTTP graph unrealized and retains real finalizer failure", async () => {
  const registry = createRegistry()
  const state = { built: 0 }
  const routes = HttpRouter.use((router) =>
    router.add("GET", "/", Effect.succeed(HttpServerResponse.text("ready"))),
  ).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.sync(() => {
          state.built += 1
        }),
      ),
    ),
  )
  retireHandler(HttpRouter.toWebHandler(routes, { disableLogger: true }), registry)
  await registry.drain()
  expect(state.built).toBe(0)
  const broken = createRegistry()
  const app = retireHandler(
    HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(Effect.addFinalizer(() => Effect.die(new Error("original HTTP finalizer failed")))),
        ),
      ),
      { disableLogger: true },
    ),
    broken,
  )
  expect((await app.handler(new Request("http://localhost/"))).status).toBe(200)
  await assert.rejects(broken.drain(), /Runtime ownership retirement failed/)
  await assert.rejects(app.dispose(), /original HTTP finalizer failed/)
})
