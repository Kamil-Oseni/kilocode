import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { CaptureState, RequestID, type Request, type CaptureStateResult } from "@/kilocode/second-brain/protocol"
import { SecondBrain } from "@/kilocode/second-brain/service"
import { selected } from "@/kilocode/second-brain/capture-state"
import { valid } from "@/kilocode/second-brain/reply"
import { pollWithTimeout, testEffect } from "../../lib/effect"

const sid = SessionID.make("ses_capture_control")
const it = testEffect(SecondBrain.layer("2 seconds").pipe(Layer.provideMerge(Bus.layer)))

test("future saving changes require an explicit original pause or resume request", () => {
  for (const text of [
    "Pause automatic memory saving.",
    "Please stop automatic saving",
    "Can you pause memory capture?",
  ])
    expect(selected(text)).toBe("pause")
  for (const text of ["Resume automatic memory saving.", "Please resume saving my personal memory."])
    expect(selected(text)).toBe("resume")
  for (const text of [
    "Is saving paused?",
    "I prefer paused memory.",
    "Pause automatic memory saving and delete all notes.",
  ])
    expect(selected(text)).toBeUndefined()
  expect(Schema.is(CaptureState)({ action: "captureState", mode: "pause" })).toBe(true)
  expect(Schema.is(CaptureState)({ action: "captureState", mode: "enable" })).toBe(false)
})

test("disabled future capture retains original saving and uncertainty instead of claiming completed cancellation", () => {
  const project = path.resolve("capture-control")
  const request: Request = {
    id: RequestID.make("control"),
    sessionID: sid,
    project,
    command: { action: "captureState", mode: "pause" },
  }
  const value: CaptureStateResult = {
    action: "captureState",
    project,
    configured: true,
    enabled: false,
    capture: "saving",
    changed: true,
  }
  expect(valid(request, value)).toBe(true)
  expect(valid(request, { ...value, capture: "uncertain" })).toBe(true)
  expect(valid(request, { ...value, enabled: true })).toBe(false)
  expect(valid(request, { ...value, configured: false })).toBe(true)
  expect(
    valid(
      { ...request, command: { action: "captureState", mode: "resume" } },
      { ...value, configured: false, enabled: true },
    ),
  ).toBe(false)
  expect(valid(request, { ...value, project: path.resolve("other") })).toBe(false)
  expect(valid(request, { ...value, enabled: true, changed: false })).toBe(true)
})

for (const mode of ["pause", "resume"] as const) {
  it.instance(`real ${mode} saving receipt stays bound to its original project`, () =>
    Effect.gen(function* () {
      const project = (yield* InstanceState.context).directory
      const brain = yield* SecondBrain.Service
      const job = yield* brain
        .request({ sessionID: sid, project, command: { action: "captureState", mode } })
        .pipe(Effect.forkChild)
      const pending = yield* pollWithTimeout(
        brain.list().pipe(Effect.map((rows) => rows[0])),
        "control request did not arrive",
        "2 seconds",
      )
      const result: CaptureStateResult = {
        action: "captureState",
        project,
        configured: true,
        enabled: mode === "resume",
        capture: mode === "resume" ? "ready" : "paused",
        changed: true,
      }
      expect(
        (yield* brain
          .reply({ requestID: pending.id, result: { ...result, enabled: mode !== "resume" } })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(yield* brain.list()).toHaveLength(1)
      yield* brain.reply({ requestID: pending.id, result })
      expect(yield* Fiber.join(job)).toEqual(result)
      expect(yield* brain.list()).toEqual([])
    }),
  )
}
