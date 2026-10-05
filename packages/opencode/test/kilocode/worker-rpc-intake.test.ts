import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Context, Effect, Layer } from "effect"
import { makeRuntime } from "../../src/effect/run-service"
import { Rpc } from "../../src/util/rpc"
import { workerIntake } from "../../src/kilocode/cli/cmd/tui/worker-intake"
import type { rpc } from "./fixtures/rpc-intake-worker"

test("worker RPC joins accepted SQLite work and replies to fenced and failed calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "raya-rpc-intake-"))
  const worker = new Worker(new URL("./fixtures/rpc-intake-worker.ts", import.meta.url))
  const client = Rpc.client<typeof rpc>(worker)
  const ready = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const failed = Promise.withResolvers<never>()
  const beginnings: number[] = []
  worker.onerror = (event) => failed.reject(new Error(event.message))

  client.on("ready", () => ready.resolve())
  client.on("held", () => held.resolve())
  client.on("closed", () => closed.resolve())
  client.on<number>("quiescing", (count) => beginnings.push(count))
  const timer = setTimeout(() => failed.reject(new Error("RPC worker acceptance timed out")), 10_000)
  const exercise = async () => {
    await ready.promise

    expect(
      String(
        await client.call("fail", undefined).then(
          () => undefined,
          (err: unknown) => err,
        ),
      ),
    ).toContain("actual RPC refusal")

    const accepted = client.call("hold", { path: join(dir, "accepted.db") })
    await held.promise

    const first = client.call("shutdown", undefined)
    const second = client.call("shutdown", undefined)
    expect(
      String(
        await client.call("fail", undefined).then(
          () => undefined,
          (err: unknown) => err,
        ),
      ),
    ).toContain("RPC intake is closing")
    worker.postMessage("fixture.release")
    expect(await accepted).toBe("joined")
    const rows = [{ value: "before shutdown" }, { value: "joined" }]
    expect(await first).toEqual(rows)
    expect(await second).toEqual(rows)
    expect(beginnings).toEqual([1])
    await closed.promise
  }
  try {
    await Promise.race([exercise(), failed.promise])
  } finally {
    clearTimeout(timer)
    worker.terminate()
  }
}, 15_000)

test("quiesce, accepted work and real cleanup failures remain joined and sticky", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  class Service extends Context.Service<Service, number>()("@test/RpcCleanup") {}
  let finalized = false
  const runtime = makeRuntime(
    Service,
    Layer.effect(
      Service,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized = true
          }).pipe(Effect.andThen(Effect.die(new Error("cleanup finalizer failed")))),
        )
        return 1
      }),
    ),
  )
  await runtime.runPromise((value) => Effect.succeed(value))
  let begun = 0
  const admit = workerIntake(() => {
    begun += 1
    throw new Error("quiesce failed")
  })
  const accepted = admit("fetch", async () => {
    started.resolve()
    await release.promise
    throw new Error("accepted call failed")
  })
  const observed = accepted.then(
    () => undefined,
    (err: unknown) => err,
  )
  await started.promise
  const first = admit("shutdown", () => runtime.retire())
  expect(begun).toBe(1)
  const failure = first.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(
    admit("shutdown", () => {
      throw new Error("must not repeat cleanup")
    }),
  ).toBe(first)
  await expect(admit("reload", () => Effect.void)).rejects.toThrow("RPC intake is closing")
  expect(finalized).toBe(false)
  release.resolve()
  expect(String(await observed)).toContain("accepted call failed")
  const error = await failure
  expect(error).toBeInstanceOf(AggregateError)
  if (error instanceof AggregateError) {
    expect(error.errors).toHaveLength(3)
    expect(error.errors.map(String)).toContain("Error: accepted call failed")
    expect(error.errors.map(String)).toContain("Error: quiesce failed")
    expect(error.errors.map(String).some((value) => value.includes("cleanup finalizer failed"))).toBe(true)
  }
  expect(finalized).toBe(true)
  expect(admit("shutdown", () => undefined)).toBe(first)
  expect(begun).toBe(1)
})

test("quiescing begins synchronously once and cleanup waits for both admitted work and quiescence", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const quiesced = Promise.withResolvers<void>()
  const events: string[] = []
  const admit = workerIntake(() => {
    events.push("quiesce")
    return quiesced.promise
  })
  const accepted = admit("fetch", async () => {
    started.resolve()
    await release.promise
    events.push("accepted")
  })
  await started.promise
  const first = admit("shutdown", () => {
    events.push("cleanup")
    return "closed"
  })
  expect(events).toEqual(["quiesce"])
  expect(admit("shutdown", () => "duplicate")).toBe(first)
  release.resolve()
  await accepted
  expect(events).toEqual(["quiesce", "accepted"])
  quiesced.resolve()
  expect(await first).toBe("closed")
  expect(events).toEqual(["quiesce", "accepted", "cleanup"])
  expect(admit("shutdown", () => "duplicate")).toBe(first)
})
