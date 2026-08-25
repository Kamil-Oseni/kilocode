// raya_change - Milestone F browser bridge tests
import { expect } from "bun:test"
import { Bus } from "@/bus"
import { Browser, HostError } from "@/kilocode/browser/service"
import { Event, type Request } from "@/kilocode/browser/protocol"
import { SessionID } from "@/session/schema"
import { Effect, Fiber, Layer, Queue } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Browser.layer("2 seconds").pipe(Layer.provideMerge(Bus.layer)))
const sessionID = SessionID.make("ses_browser_test")

it.instance(
  "publishes, lists, correlates, and completes browser requests",
  () =>
    Effect.gen(function* () {
      const browser = yield* Browser.Service
      const bus = yield* Bus.Service
      const events = yield* Queue.unbounded<Request>()
      const off = yield* bus.subscribeCallback(Event.Requested, (event) => Queue.offerUnsafe(events, event.properties))
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const fiber = yield* browser
        .request({ operation: "navigate", sessionID, url: "https://example.com" })
        .pipe(Effect.forkChild)
      const request = yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))
      expect(request).toMatchObject({ operation: "navigate", sessionID, url: "https://example.com" })
      expect(yield* browser.list()).toEqual([request])

      const invalid = yield* browser
        .reply({
          requestID: request.id,
          result: { operation: "snapshot", url: "https://example.com", snapshot: "page" },
        })
        .pipe(Effect.flip)
      expect(invalid._tag).toBe("Browser.InvalidReplyError")

      yield* browser.reply({
        requestID: request.id,
        result: { operation: "navigate", url: "https://example.com", title: "Example" },
      })
      expect(yield* Fiber.join(fiber)).toEqual({
        operation: "navigate",
        url: "https://example.com",
        title: "Example",
      })
      expect(yield* browser.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "propagates host rejection and timeout",
  () =>
    Effect.gen(function* () {
      const browser = yield* Browser.Service
      const fiber = yield* browser.request({ operation: "snapshot", sessionID }).pipe(Effect.forkChild)
      const pending = yield* browser.list().pipe(Effect.repeat({ until: (items) => items.length === 1 }))
      yield* browser.reject({
        requestID: pending[0].id,
        error: { code: "disconnected", message: "Browser runtime is unavailable" },
      })
      const err = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(err).toBeInstanceOf(HostError)
      expect(err.message).toContain("unavailable")

      const timeout = yield* browser.request({ operation: "snapshot", sessionID }).pipe(Effect.flip)
      expect(timeout.code).toBe("timeout")
      expect(yield* browser.list()).toEqual([])
    }),
  { git: true },
)
