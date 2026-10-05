import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { catalog } from "../../../src/kilocode/catalog-owner"
import { RuntimeRegistry } from "../../../src/kilocode/runtime-registry"
import { ProfileRoots } from "../../../src/kilocode/profile-roots"
import { coordinateNativeRoots } from "../../../src/kilocode/profile-maintenance"

const mode = process.argv[2]
const root = process.env.RAYA_CATALOG_FIXTURE
assert.ok(root)
const started = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const calls = { requests: 0, bodies: 0, aborted: 0 }
const receipt = path.join(root, "receipt.json")
const cache = path.join(root, "catalog")
const profile = () => ({ mode, root, calls, participant: catalog.snapshot(), roots: ProfileRoots.snapshot() })

async function markers() {
  const dir = path.join(cache, ".raya-profile-locks")
  const names = existsSync(dir) ? await readdir(dir) : []
  return (
    await Promise.all(
      names
        .filter((name) => name.endsWith(".writers"))
        .map(async (name) => (await readdir(path.join(dir, name))).length),
    )
  ).reduce((sum, value) => sum + value, 0)
}

if (mode === "unused" || mode === "closed") {
  if (mode === "closed") {
    const scope = Scope.makeUnsafe()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const fiber = await Effect.runPromise(
      catalog.fork(
        path.join(cache, "models.json"),
        () =>
          Effect.promise(async () => {
            calls.bodies++
            await writeFile(path.join(cache, "unreachable.json"), "{}")
          }),
        scope,
      ),
    )
    await new Promise<void>((resolve) => fiber.addObserver(() => resolve()))
    assert.equal(calls.bodies, 0)
    assert.equal(catalog.snapshot().active, 0)
    await RuntimeRegistry.drain()
    assert.equal(catalog.snapshot().failures, 0)
  } else await RuntimeRegistry.drain()
  assert.equal(ProfileRoots.snapshot().length, 0)
  assert.equal(existsSync(cache), false)
  await writeFile(receipt, JSON.stringify({ ok: true, ...profile() }))
} else {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.requests++
      request.signal.addEventListener(
        "abort",
        () => {
          calls.aborted++
        },
        { once: true },
      )
      if (mode === "held" || mode === "alias" || mode === "periodic" || mode === "scope" || mode === "timeout") {
        started.resolve()
        await release.promise
      }
      return mode === "transport-failure" ? new Response("catalog unavailable", { status: 500 }) : Response.json({})
    },
  })
  const { Flag } = await import("../../../src/flag/flag")
  Flag.KILO_MODELS_URL = `http://127.0.0.1:${server.port}`
  Flag.KILO_DISABLE_MODELS_FETCH = mode !== "periodic" && mode !== "scope" && mode !== "idle"
  Flag.KILO_MODELS_PATH = undefined
  const { Global } = await import("../../../src/global")
  Global.Path.cache = cache
  const { ModelsDev } = await import("../../../src/models-dev")
  const { FSUtil } = await import("../../../src/fs-util")
  const { AppNodeBuilder } = await import("../../../src/effect/app-node-builder")
  const { Hash } = await import("../../../src/util/hash")
  const file = path.join(cache, `models-${Hash.fast(Flag.KILO_MODELS_URL)}.json`)
  await mkdir(cache, { recursive: true })
  const external = path.join(root, "external-catalog")
  if (mode === "external-read") {
    await mkdir(external)
    Flag.KILO_MODELS_PATH = external
  }
  const adapter = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        stat: (target) => fs.stat(mode === "stat-failure" ? target + "\0" : target),
        rename: (from, to) =>
          Effect.gen(function* () {
            if (mode === "publication") {
              started.resolve()
              yield* Effect.promise(() => release.promise)
            }
            return yield* fs.rename(from, to)
          }),
      })
    }),
  ).pipe(Layer.provide(FSUtil.defaultLayer))
  const layer = () =>
    AppNodeBuilder.build(
      ModelsDev.node,
      mode === "publication" || mode === "stat-failure" ? [[FSUtil.node, adapter]] : [],
    )
  const first = ManagedRuntime.make(layer())
  const second = ManagedRuntime.make(layer())
  const runtimes = [first, second]
  try {
    const service = await first.runPromise(ModelsDev.Service)
    if (mode === "timeout") {
      const begin = performance.now()
      const work = first.runPromise(service.refresh(true))
      await started.promise
      await work
      const elapsed = performance.now() - begin
      assert.ok(elapsed >= 9_000 && elapsed < 15_000, `actual request timeout took ${elapsed}ms`)
      assert.equal(calls.requests, 1)
      assert.equal(existsSync(file), false)
      assert.equal(catalog.snapshot().active, 0)
      assert.equal(catalog.snapshot().failures, 1)
      const error = await RuntimeRegistry.drain().then(
        () => undefined,
        (err: unknown) => err,
      )
      assert.ok(error instanceof AggregateError)
      const nested = error.errors[0]
      assert.ok(nested instanceof AggregateError)
      const cause = nested.errors[0]
      assert.ok(Cause.isCause(cause))
      assert.ok(
        cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error instanceof Cause.TimeoutError),
      )
      const deadline = performance.now() + 1_000
      while (calls.aborted === 0) {
        assert.ok(performance.now() < deadline, "actual loopback peer did not observe timeout disconnect")
        await Bun.sleep(1)
      }
      assert.equal(calls.aborted, 1)
      release.resolve()
    } else if (mode === "idle") {
      const deadline = performance.now() + 5_000
      while (catalog.snapshot().active !== 0) {
        assert.ok(performance.now() < deadline)
        await Bun.sleep(1)
      }
      assert.equal(calls.requests, 1)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {})
      await first.dispose()
      await RuntimeRegistry.drain()
      assert.equal(catalog.snapshot().failures, 0)
    } else if (mode === "interrupt") {
      const exit = await Effect.runPromise(catalog.run(file, () => Effect.interrupt).pipe(Effect.exit))
      assert.ok(Exit.isFailure(exit))
      await assert.rejects(RuntimeRegistry.drain(), AggregateError)
      assert.equal(catalog.snapshot().failures, 1)
    } else if (mode === "scope") {
      await started.promise
      const disposing = first.dispose()
      let settled = false
      void disposing.then(() => {
        settled = true
      })
      await Bun.sleep(75)
      assert.equal(settled, false)
      assert.ok((await markers()) > 0)
      assert.equal(existsSync(file), false)
      release.resolve()
      await disposing
      await RuntimeRegistry.drain()
      assert.equal(calls.requests, 1)
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {})
      assert.equal(catalog.snapshot().failures, 0)
    } else if (mode === "corrupt") {
      await writeFile(file, "{invalid")
      assert.deepEqual(await first.runPromise(service.get()), {})
      assert.equal(existsSync(file), false)
      assert.equal(calls.requests, 0)
      await RuntimeRegistry.drain()
      await writeFile(file, "{late invalid")
      await assert.rejects(second.runPromise(ModelsDev.Service.use((next) => next.get())))
      assert.equal(await readFile(file, "utf8"), "{late invalid")
      assert.equal(calls.requests, 0)
    } else if (mode === "read-failure" || mode === "external-read" || mode === "stat-failure") {
      if (mode === "read-failure") await mkdir(file)
      if (mode === "stat-failure") await first.runPromise(service.refresh())
      else assert.deepEqual(await first.runPromise(service.get()), {})
      assert.ok(catalog.snapshot().failures > 0)
      await assert.rejects(RuntimeRegistry.drain(), AggregateError)
      if (mode === "external-read") {
        assert.deepEqual(await readdir(external), [])
        assert.equal(existsSync(file), false)
      }
    } else if (mode === "failure" || mode === "transport-failure") {
      if (mode === "failure") await mkdir(file)
      await first.runPromise(service.refresh(true))
      assert.equal(catalog.snapshot().failures, 1)
      const closed = RuntimeRegistry.drain()
      await assert.rejects(closed, AggregateError)
      assert.equal(RuntimeRegistry.drain(), closed)
      assert.equal(catalog.snapshot().active, 0)
      assert.equal((await readdir(cache)).filter((name) => name.endsWith(".tmp")).length, 0)
      if (mode === "transport-failure") assert.equal(calls.requests, 3)
    } else {
      const work = mode === "periodic" ? Promise.resolve() : first.runPromise(service.refresh(true))
      await started.promise
      if (mode === "alias") {
        const alias = path.join(root, "alias")
        await symlink(cache, alias, "junction")
        Global.Path.cache = alias
      }
      const other = mode === "held" || mode === "alias" ? await second.runPromise(ModelsDev.Service) : undefined
      const accepted = other ? second.runPromise(other.refresh(true)) : Promise.resolve()
      if (other) {
        const deadline = performance.now() + 5_000
        while (catalog.snapshot().active !== 2) {
          assert.ok(performance.now() < deadline)
          await Bun.sleep(1)
        }
      }
      assert.ok(catalog.snapshot().active > 0)
      assert.ok((await markers()) > 0)
      const maintenance = { entered: false }
      const capture =
        mode === "held"
          ? coordinateNativeRoots([{ kind: "json", path: file }], async () => {
              maintenance.entered = true
              assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {})
            })
          : undefined
      const captured = capture?.then(
        (value) => ({ ok: true, value }),
        (err: unknown) => ({ ok: false, err }),
      )
      const closed = RuntimeRegistry.drain()
      const outcome = closed.then(
        () => ({ ok: true }),
        (err: unknown) => ({ ok: false, err }),
      )
      let settled = false
      void outcome.then(() => {
        settled = true
      })
      await Promise.resolve()
      assert.equal(settled, false)
      assert.equal(maintenance.entered, false)
      const before = calls.requests
      await assert.rejects(first.runPromise(service.refresh(true)), /registration is closed|admission is terminal/)
      assert.equal(calls.requests, before)
      release.resolve()
      await Promise.all([work, accepted])
      const result = await outcome
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {})
      assert.equal(calls.requests, other ? 2 : 1)
      if (captured) {
        const result = await captured
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(maintenance.entered, true)
      }
      assert.equal(ProfileRoots.snapshot().length, 1)
    }
    assert.equal(await markers(), 0)
    assert.equal(catalog.snapshot().active, 0)
    assert.equal(catalog.snapshot().timers, 0)
    await assert.rejects(
      Effect.runPromise(
        catalog.run(file, () =>
          Effect.sync(() => {
            calls.bodies++
          }),
        ),
      ),
    )
    assert.equal(calls.bodies, 0)
    await writeFile(receipt, JSON.stringify({ ok: true, file, ...profile() }))
  } finally {
    release.resolve()
    await Promise.all(runtimes.map((runtime) => runtime.dispose()))
    await server.stop(true)
  }
}
console.log(JSON.stringify({ receipt, ...profile() }))
