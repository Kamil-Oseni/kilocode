// raya_change - native desktop host bridge tests
import { expect } from "bun:test"
import { Bus } from "@/bus"
import { ObservationID } from "@/kilocode/computer-use/protocol"
import { Event, type Request } from "@/kilocode/desktop/protocol"
import { Desktop, HostError } from "@/kilocode/desktop/service"
import { SessionID } from "@/session/schema"
import { Effect, Fiber, Layer, Queue } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Desktop.layer("100 millis").pipe(Layer.provideMerge(Bus.layer)))
const sessionID = SessionID.make("ses_desktop_test")

it.instance(
  "publishes, lists, correlates, and completes desktop observations",
  () =>
    Effect.gen(function* () {
      const desktop = yield* Desktop.Service
      const bus = yield* Bus.Service
      const events = yield* Queue.unbounded<Request>()
      const off = yield* bus.subscribeCallback(Event.Requested, (event) => Queue.offerUnsafe(events, event.properties))
      yield* Effect.addFinalizer(() => Effect.sync(off))
      const fiber = yield* desktop.request({ operation: "observe", sessionID }).pipe(Effect.forkChild)
      const request = yield* Queue.take(events).pipe(Effect.timeout("1 second"))
      expect(yield* desktop.list()).toEqual([request])
      const observation = {
        version: 1 as const,
        id: ObservationID.make("obs_desktop_test"),
        observedAt: 1,
        validUntil: 2,
        target: { surface: "desktop" as const, windowID: "window_1" },
      }
      const receipt = {
        version: 1 as const,
        requestID: request.id,
        startedAt: 1,
        finishedAt: 2,
        effect: "observe" as const,
        outcome: "confirmed" as const,
        target: observation.target,
        observationID: observation.id,
      }
      const result = { operation: "observe" as const, width: 10, height: 8, mime: "image/png" as const, data: "cG5n", observation, receipt }
      yield* desktop.reply({ requestID: request.id, result })
      expect(yield* Fiber.join(fiber)).toEqual(result)
      expect(yield* desktop.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "propagates rejection and refuses to retain timed-out requests",
  () =>
    Effect.gen(function* () {
      const desktop = yield* Desktop.Service
      const fiber = yield* desktop.request({ operation: "observe", sessionID }).pipe(Effect.forkChild)
      const pending = yield* desktop.list().pipe(Effect.repeat({ until: (items) => items.length === 1 }))
      yield* desktop.reject({
        requestID: pending[0].id,
        error: { code: "unsupported", message: "Desktop observation is unavailable" },
      })
      const err = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(err).toBeInstanceOf(HostError)
      expect(err.message).toContain("unavailable")
      const timeout = yield* desktop.request({ operation: "observe", sessionID }).pipe(Effect.flip)
      expect(timeout.code).toBe("timeout")
      expect(yield* desktop.list()).toEqual([])
    }),
  { git: true },
)
