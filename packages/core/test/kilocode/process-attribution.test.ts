import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Cause, Fiber } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "../../src/effect/layer-node"
import { AppProcess } from "../../src/process"
import { footer } from "../../src/kilocode/process-attribution"

const prior = process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS

afterEach(() => {
  if (prior === undefined) delete process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS
  else process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = prior
})

test("enabled cancellation and genuine spawn failure retain original failures and incomplete footer", async () => {
  process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = "1"
  const before = footer()
  const cfg = new AbortController()
  cfg.abort(new Error("original cancellation marker"))
  const failed = await Effect.runPromise(
    AppProcess.Service.use((svc) =>
      svc.run(
        ChildProcess.make(process.execPath, ["-e", "setInterval(()=>{},10000)"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
        { signal: cfg.signal },
      ),
    ).pipe(Effect.exit, Effect.provide(LayerNode.compile(AppProcess.node))),
  )
  expect(Exit.isFailure(failed)).toBe(true)
  if (Exit.isFailure(failed)) {
    const errors = Cause.prettyErrors(failed.cause)
    expect(errors.some((err) => err.message.includes("original cancellation marker"))).toBe(true)
  }
  const missing = await Effect.runPromise(
    AppProcess.Service.use((svc) =>
      svc.run(
        ChildProcess.make(process.execPath, ["-e", "process.exit(0)"], {
          cwd: path.join(os.tmpdir(), "raya-absent-private-fixture-9ade30fc"),
        }),
      ),
    ).pipe(Effect.exit, Effect.provide(LayerNode.compile(AppProcess.node))),
  )
  expect(Exit.isFailure(missing)).toBe(true)
  const root = await mkdtemp(path.join(os.tmpdir(), "attribution-ready-"))
  const file = path.join(root, "ready")
  const interrupted = await (async () => {
    try {
      return await Effect.runPromise(
        AppProcess.Service.use((svc) =>
          Effect.gen(function* () {
            const script = `await Bun.write(${JSON.stringify(file)}, String(process.pid)); setInterval(()=>{},10000)`
            const fiber = yield* svc
              .run(
                ChildProcess.make(process.execPath, ["-e", script], {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              )
              .pipe(Effect.forkChild)
            yield* Effect.gen(function* () {
              while (!(yield* Effect.promise(() => Bun.file(file).exists()))) yield* Effect.sleep("10 millis")
              const pid = yield* Effect.promise(() => Bun.file(file).text())
              expect(Number(pid)).toBeGreaterThan(0)
            }).pipe(Effect.timeout("5 seconds"))
            yield* Fiber.interrupt(fiber)
            return yield* Fiber.await(fiber)
          }),
        ).pipe(Effect.scoped, Effect.provide(LayerNode.compile(AppProcess.node))),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })()
  expect(Exit.isFailure(interrupted)).toBe(true)
  if (Exit.isFailure(interrupted)) expect(Cause.hasInterrupts(interrupted.cause)).toBe(true)
  expect(footer().interrupted - before.interrupted).toBe(1)
  expect(footer().attempted - before.attempted).toBe(3)
  expect(footer().settled - before.settled).toBe(3)
  expect(footer().rejected - before.rejected).toBe(3)
  expect(footer().emitted - before.emitted).toBe(0)
  expect(footer().attempted).toBeGreaterThan(footer().emitted)
  expect(footer().recordsComplete).toBe(false)
})

test("disabled diagnostics preserve original cancellation without counters or diagnostic finalizer", async () => {
  process.env.RAYA_SOURCE_MEMBER_DIAGNOSTICS = "0"
  const before = footer()
  const cfg = new AbortController()
  cfg.abort(new Error("disabled original cancellation"))
  const exit = await Effect.runPromise(
    AppProcess.Service.use((svc) =>
      svc.run(
        ChildProcess.make(process.execPath, ["-e", "setInterval(()=>{},10000)"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
        { signal: cfg.signal },
      ),
    ).pipe(Effect.exit, Effect.provide(LayerNode.compile(AppProcess.node))),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(footer()).toEqual(before)
})
