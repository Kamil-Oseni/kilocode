import assert from "node:assert/strict"
import { closeSync, fstatSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, FileSystem, Layer, Logger, ManagedRuntime, Scope } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { drainFileLoggers, ownedFileLogger } from "../../../src/kilocode/file-logger"

const root = (() => {
  const value = process.env.RAYA_LOGGER_FIXTURE
  if (!value) throw new Error("Missing isolated logger fixture root")
  return value
})()
const mode = process.argv[2]
const file = mode === "open-failure" ? join(root, "absent", "actual.log") : join(root, "actual.log")
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const state = { fd: undefined as number | undefined, writes: 0, settled: false }
async function run() {
  if (mode === "closed") {
    const scope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const result = await Effect.runPromise(
      Scope.provide(scope)(
        ownedFileLogger(
          Logger.make(() => "closed"),
          file,
        ),
      ).pipe(Effect.provide(NodeFileSystem.layer), Effect.exit),
    )
    assert.equal(result._tag, "Failure")
    assert.equal(await Bun.file(file).exists(), false)
    await drainFileLoggers()
    return
  }
  if (mode === "unused") {
    const first = drainFileLoggers()
    assert.equal(drainFileLoggers(), first)
    await first
    assert.equal(await Bun.file(file).exists(), false)
    return
  }
  const native = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return FileSystem.make({
        ...fs,
        open: (...args) =>
          fs.open(...args).pipe(
            Effect.flatMap((handle) =>
              Effect.gen(function* () {
                state.fd = Number(handle.fd)
                if (mode === "held-open") {
                  entered.resolve()
                  yield* Effect.promise(() => release.promise)
                }
                return {
                  ...handle,
                  write: (buffer) =>
                    Effect.gen(function* () {
                      state.writes++
                      entered.resolve()
                      if (mode === "held") yield* Effect.promise(() => release.promise)
                      return yield* handle.write(buffer)
                    }),
                }
              }),
            ),
          ),
      })
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))
  const formatter = Logger.make((options) => String(options.message))
  const runtime = ManagedRuntime.make(
    Logger.layer([ownedFileLogger(formatter, file)], { mergeWithExisting: false }).pipe(Layer.provide(native)),
  )
  const start = runtime.runPromise(mode === "close-failure" ? Effect.void : Effect.logInfo("ACCEPTED_NATIVE_LOG"))
  const started = start.then(
    () => undefined,
    (err: unknown) => err,
  )
  if (mode === "held-open") {
    await entered.promise
    const pending = drainFileLoggers()
    void pending.then(
      () => {
        state.settled = true
      },
      () => {
        state.settled = true
      },
    )
    assert.equal(drainFileLoggers(), pending)
    try {
      await Bun.sleep(50)
      assert.equal(state.settled, false)
      fstatSync(state.fd!)
    } finally {
      release.resolve()
      await pending
    }
    assert.equal(await started, undefined)
    await pending
    await runtime.dispose()
    assert.throws(() => fstatSync(state.fd!), { code: "EBADF" })
    assert.equal(await Bun.file(file).text(), "")
    await Bun.write(
      join(root, "receipt.json"),
      JSON.stringify({ ok: true, mode, writes: state.writes, nativeClosed: true, portableCaptureAuthorized: false }),
    )
    return
  }
  if (mode === "open-failure") {
    assert.notEqual(await started, undefined)
    await runtime.dispose().catch((err: unknown) => {
      assert.ok(err instanceof Error)
    })
    const failure = await drainFileLoggers().then(
      () => undefined,
      (err: unknown) => err,
    )
    assert.ok(failure instanceof AggregateError)
    await Bun.write(
      join(root, "receipt.json"),
      JSON.stringify({ ok: true, mode, writes: state.writes, portableCaptureAuthorized: false }),
    )
    return
  }
  assert.equal(await started, undefined)
  assert.ok(state.fd !== undefined)
  if (mode === "graphs") {
    const first = state.fd
    const second = ManagedRuntime.make(
      Logger.layer([ownedFileLogger(formatter, file)], { mergeWithExisting: false }).pipe(Layer.provide(native)),
    )
    await second.runPromise(Effect.logInfo("SECOND_NATIVE_LOG"))
    const next = state.fd
    assert.notEqual(next, first)
    await drainFileLoggers()
    await Promise.all([runtime.dispose(), second.dispose()])
    assert.throws(() => fstatSync(first), { code: "EBADF" })
    assert.throws(() => fstatSync(next), { code: "EBADF" })
    assert.deepEqual((await Bun.file(file).text()).trim().split("\n").sort(), [
      "ACCEPTED_NATIVE_LOG",
      "SECOND_NATIVE_LOG",
    ])
    return
  }
  if (mode === "write-failure" || mode === "close-failure") closeSync(state.fd)
  if (mode === "held") {
    await entered.promise
    const pending = drainFileLoggers()
    void pending.then(
      () => {
        state.settled = true
      },
      () => {
        state.settled = true
      },
    )
    assert.equal(drainFileLoggers(), pending)
    await runtime.runPromise(Effect.logInfo("REFUSED_LATE_LOG"))
    try {
      await Bun.sleep(50)
      assert.equal(state.settled, false)
      fstatSync(state.fd)
    } finally {
      release.resolve()
      await pending
    }
    await pending
    await runtime.dispose()
  }
  if (mode !== "held") {
    const result = await runtime.dispose().then(
      () => undefined,
      (err: unknown) => err,
    )
    if (mode === "write-failure" || mode === "close-failure") {
      assert.ok(result instanceof AggregateError || result instanceof Error)
      const first = drainFileLoggers()
      assert.equal(drainFileLoggers(), first)
      const failure = await first.then(
        () => undefined,
        (err: unknown) => err,
      )
      assert.ok(failure instanceof AggregateError)
      assert.equal(
        await drainFileLoggers().then(
          () => undefined,
          (err: unknown) => err,
        ),
        failure,
      )
    }
    if (mode !== "write-failure" && mode !== "close-failure") {
      assert.equal(result, undefined)
      await drainFileLoggers()
    }
  }
  assert.throws(() => fstatSync(state.fd!), { code: "EBADF" })
  if (mode !== "write-failure" && mode !== "close-failure")
    assert.equal((await Bun.file(file).text()).trim(), "ACCEPTED_NATIVE_LOG")
  const late = await Effect.runPromise(
    ownedFileLogger(formatter, join(root, "late.log")).pipe(
      Effect.scoped,
      Effect.provide(NodeFileSystem.layer),
      Effect.exit,
    ),
  )
  assert.equal(late._tag, "Failure")
  assert.equal(await Bun.file(join(root, "late.log")).exists(), false)
}
await run()
await Bun.write(
  join(root, "receipt.json"),
  JSON.stringify({
    ok: true,
    mode,
    writes: state.writes,
    nativeClosed: state.fd !== undefined,
    portableCaptureAuthorized: false,
  }),
)
