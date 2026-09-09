import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { EffectBridge } from "@/effect/bridge"
import { Execution, observe } from "@/kilocode/effect/observation"
import { cancel } from "@/kilocode/effect/cancellation"
import { it, pollWithTimeout } from "../lib/effect"

it.live(
  "executing work carries its own identity across nested runners without leaking to the caller",
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const outer = Runner.make<string>(scope)
    const inner = Runner.make<string>(scope)
    const current = Effect.serviceOption(Execution).pipe(
      Effect.map((value) => (value._tag === "Some" ? value.value.id : undefined)),
    )
    expect(yield* current).toBeUndefined()
    const result = yield* outer.ensureRunning(
      Effect.gen(function* () {
        const id = yield* current
        expect(id).toBe(observe(outer).id)
        expect(typeof id).toBe("string")
        const bridge = yield* EffectBridge.make()
        expect(yield* Effect.promise(() => bridge.promise(current))).toBe(id)
        const child = yield* inner.ensureRunning(
          Effect.gen(function* () {
            const nested = yield* current
            expect(nested).toBe(observe(inner).id)
            expect(nested).not.toBe(id)
            return nested!
          }),
        )
        expect(child).not.toBe(id)
        expect(yield* current).toBe(id)
        return id!
      }),
    )
    expect(typeof result).toBe("string")
    expect(yield* current).toBeUndefined()
  }),
)

it.live(
  "a worker finishing before cancellation executes is not reported as interrupted",
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const runner = Runner.make<string>(scope)
    const release = yield* Deferred.make<void>()
    const work = yield* runner
      .ensureRunning(Deferred.await(release).pipe(Effect.as("completed")))
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => observe(runner).id),
      "worker did not start",
    )
    const [stop] = cancel(runner.state, observe(runner).id!, Effect.void, new Runner.Cancelled())
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(work)).toBe("completed")
    expect(yield* stop).toBe(false)
  }),
)

it.live(
  "cancellation requests release control locks before cleanup and survive an interrupted waiter",
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const runner = Runner.make<string>(scope, { onInterrupt: Effect.succeed("cancelled") })
    const started = yield* Deferred.make<void>()
    const cleanup = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const work = yield* runner
      .ensureRunning(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release)))),
        ),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    const id = observe(runner).id!
    const stopped = yield* runner.requestCancel(id)
    // Returning the wait handle cannot depend on completion of worker cleanup.
    yield* Deferred.await(cleanup)
    expect(observe(runner)).toEqual({ phase: "idle" })
    const waiter = yield* stopped.pipe(Effect.forkChild)
    yield* Fiber.interrupt(waiter)
    const next = yield* runner.ensureRunning(Effect.never).pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => (observe(runner).phase === "running" ? true : undefined)),
      "replacement worker did not start",
    )
    const replacement = observe(runner)
    expect(replacement.id).not.toBe(id)
    expect(yield* yield* runner.requestCancel(id)).toBe(false)
    yield* Deferred.succeed(release, undefined)
    expect(yield* stopped).toBe(true)
    expect(yield* Fiber.join(work)).toBe("cancelled")
    expect(observe(runner)).toEqual(replacement)
    yield* runner.cancel
    yield* Fiber.join(next)
  }),
)

it.live(
  "observations retain actual execution identity through waiter interruption and queued shell work",
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const runner = Runner.make<string>(scope)
    expect(observe()).toEqual({ phase: "idle" })
    expect(observe(runner)).toEqual({ phase: "idle" })
    const shell = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const waiter = yield* runner.startShell(Deferred.await(shell).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => (runner.state._tag === "Shell" ? true : undefined)),
      "shell did not start",
    )
    const original = observe(runner)
    expect(original.phase).toBe("shell")
    expect(observe(runner)).toEqual(original)
    const entered = yield* Deferred.make<string | undefined>()
    const work = yield* runner
      .ensureRunning(
        Effect.gen(function* () {
          const execution = yield* Effect.serviceOption(Execution)
          yield* Deferred.succeed(entered, execution._tag === "Some" ? execution.value.id : undefined)
          yield* Deferred.await(release)
          return "done"
        }),
      )
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => (runner.state._tag === "ShellThenRun" ? true : undefined)),
      "work did not queue",
    )
    const queued = observe(runner)
    expect(queued.id).toBe(original.id)
    expect(queued.queued).toBeDefined()
    expect(queued.queued).not.toBe(queued.id)
    expect(yield* runner.cancelRun(queued.id!)).toBe(false)
    expect(yield* runner.cancelRun(queued.queued!)).toBe(false)
    expect(observe(runner)).toEqual(queued)
    yield* Deferred.succeed(shell, undefined)
    yield* Fiber.join(waiter)
    yield* pollWithTimeout(
      Effect.sync(() => (runner.state._tag === "Running" ? true : undefined)),
      "work did not start",
    )
    const running = observe(runner)
    expect(running.id).toBe(queued.queued)
    expect(yield* Deferred.await(entered)).toBe(queued.queued)
    expect(running.phase).toBe("running")
    yield* Fiber.interrupt(work)
    expect(observe(runner)).toEqual(running)
    yield* Deferred.succeed(release, undefined)
    yield* pollWithTimeout(
      Effect.sync(() => (runner.state._tag === "Idle" ? true : undefined)),
      "work did not finish",
    )
    expect(observe(runner)).toEqual({ phase: "idle" })
    const next = yield* runner.ensureRunning(Effect.never).pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => (runner.state._tag === "Running" ? true : undefined)),
      "next work did not start",
    )
    expect(observe(runner).id).not.toBe(running.id)
    yield* Fiber.interrupt(next)
    yield* runner.cancel
    expect(observe(runner)).toEqual({ phase: "idle" })
  }),
)

it.live(
  "conditional cancellation stops only the observed running execution",
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const runner = Runner.make<string>(scope, { onInterrupt: Effect.succeed("cancelled") })
    const ids: string[] = []
    expect(yield* runner.cancelRun("missing")).toBe(false)
    for (let index = 0; index < 2; index++) {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const before = observe(runner)
      if (!before.id) throw new Error("Missing execution identity")
      expect(yield* runner.cancelRun(ids.at(-1) ?? "wrong")).toBe(false)
      expect(observe(runner)).toEqual(before)
      expect(yield* runner.cancelRun(before.id)).toBe(true)
      yield* Deferred.await(stopped)
      expect(yield* Fiber.join(fiber)).toBe("cancelled")
      expect(observe(runner)).toEqual({ phase: "idle" })
      expect(yield* runner.cancelRun(before.id)).toBe(false)
      ids.push(before.id)
    }
    expect(ids[0]).not.toBe(ids[1])
  }),
)
