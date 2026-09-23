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
      const result = {
        operation: "observe" as const,
        width: 10,
        height: 8,
        mime: "image/png" as const,
        data: "cG5n",
        timing: { acquisitionMs: 5, preparationMs: 7, semanticsMs: 3, totalMs: 20 },
        semantics: {
          source: "windows_ui_automation" as const,
          status: "available" as const,
          viewport: { x: 0, y: 0, width: 10, height: 8 },
          controls: [
            {
              controlID: "42.7",
              role: "Button",
              name: "Save",
              x: 100,
              y: 80,
              width: 64,
              height: 28,
              enabled: true,
              focused: false,
              actions: ["invoke" as const],
            },
          ],
          truncated: false,
        },
        observation,
        receipt,
      }
      yield* desktop.reply({ requestID: request.id, result })
      expect(yield* Fiber.join(fiber)).toEqual(result)
      expect(yield* desktop.list()).toEqual([])

      const click = yield* desktop
        .request({
          operation: "click",
          sessionID,
          windowID: "window_1",
          observationID: observation.id,
          sensitive: false,
          action: "click",
          button: "left",
          x: 0.5,
          y: 0.25,
        })
        .pipe(Effect.forkChild)
      const clickRequest = yield* Queue.take(events).pipe(Effect.timeout("1 second"))
      const mismatch = yield* desktop.reply({ requestID: clickRequest.id, result }).pipe(Effect.flip)
      expect(mismatch._tag).toBe("Desktop.InvalidReplyError")
      const clickReceipt = { ...receipt, requestID: clickRequest.id, effect: "interact" as const }
      const clicked = { operation: "click" as const, receipt: clickReceipt }
      yield* desktop.reply({ requestID: clickRequest.id, result: clicked })
      expect(yield* Fiber.join(click)).toEqual(clicked)

      const windows = yield* desktop.request({ operation: "windows", sessionID }).pipe(Effect.forkChild)
      const windowsRequest = yield* Queue.take(events).pipe(Effect.timeout("1 second"))
      const catalog = {
        ...observation,
        id: ObservationID.make("obs_desktop_windows"),
        target: { surface: "desktop" as const, windowID: "visible-windows", location: "catalog" },
      }
      const listed = {
        operation: "windows" as const,
        windows: [
          {
            windowID: "window_1",
            title: "Editor",
            processID: 5,
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
            minimized: false,
            foreground: true,
          },
        ],
        observation: catalog,
        receipt: {
          ...receipt,
          requestID: windowsRequest.id,
          target: catalog.target,
          observationID: catalog.id,
        },
      }
      yield* desktop.reply({ requestID: windowsRequest.id, result: listed })
      expect(yield* Fiber.join(windows)).toEqual(listed)

      const focus = yield* desktop
        .request({ operation: "focus", sessionID, windowID: "window_1", observationID: catalog.id, sensitive: false })
        .pipe(Effect.forkChild)
      const focusRequest = yield* Queue.take(events).pipe(Effect.timeout("1 second"))
      const focused = {
        operation: "focus" as const,
        receipt: {
          ...receipt,
          requestID: focusRequest.id,
          effect: "manage" as const,
          target: { surface: "desktop" as const, windowID: "window_1" },
          observationID: catalog.id,
        },
      }
      yield* desktop.reply({ requestID: focusRequest.id, result: focused })
      expect(yield* Fiber.join(focus)).toEqual(focused)
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
      const receipt = {
        version: 1 as const,
        requestID: pending[0].id,
        startedAt: 1,
        finishedAt: 2,
        effect: "interact" as const,
        outcome: "unknown" as const,
        target: { surface: "desktop" as const, windowID: "window_1" },
        observationID: ObservationID.make("obs_desktop_uncertain"),
      }
      yield* desktop.reject({
        requestID: pending[0].id,
        error: { code: "unsupported", message: "Desktop input completion is uncertain", receipt },
      })
      const err = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(err).toBeInstanceOf(HostError)
      expect(err.receipt).toEqual(receipt)
      expect(err.message).toContain("Do not automatically retry")
      const timeout = yield* desktop.request({ operation: "observe", sessionID }).pipe(Effect.flip)
      expect(timeout.code).toBe("timeout")
      expect(yield* desktop.list()).toEqual([])
    }),
  { git: true },
)
