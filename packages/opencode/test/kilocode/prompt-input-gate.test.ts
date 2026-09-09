import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { gate } from "@/kilocode/session/input-gate"
import { SessionID } from "@/session/schema"
import { it } from "../lib/effect"

it.live(
  "prompt intake serializes a session while other sessions remain independent",
  Effect.gen(function* () {
    const id = SessionID.make(`ses_input_${crypto.randomUUID()}`)
    const other = SessionID.make(`ses_input_${crypto.randomUUID()}`)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const events: string[] = []
    const first = yield* KiloSessionPrompt.intake(
      id,
      Effect.gen(function* () {
        events.push("first")
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        events.push("saved")
      }),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const second = yield* KiloSessionPrompt.intake(
      id,
      Effect.sync(() => events.push("second")),
    ).pipe(Effect.forkChild)
    yield* KiloSessionPrompt.intake(
      other,
      Effect.sync(() => events.push("other")),
    )
    expect(events).toEqual(["first", "other"])
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect(events).toEqual(["first", "other", "saved", "second"])
    expect(yield* gate.size).toBe(0)
  }),
)

it.live(
  "aborted input releases its gate without running a cancelled waiting write",
  Effect.gen(function* () {
    const id = SessionID.make(`ses_input_${crypto.randomUUID()}`)
    const entered = yield* Deferred.make<void>()
    let writes = 0
    const first = yield* KiloSessionPrompt.intake(
      id,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const waiting = yield* KiloSessionPrompt.intake(
      id,
      Effect.sync(() => writes++),
    ).pipe(Effect.forkChild)
    yield* Fiber.interrupt(waiting)
    yield* KiloSessionPrompt.abortIntakes(id)
    yield* Fiber.await(first)
    expect(writes).toBe(0)
    yield* KiloSessionPrompt.intake(
      id,
      Effect.sync(() => writes++),
    )
    expect(writes).toBe(1)
    expect(yield* gate.size).toBe(0)
  }),
)
