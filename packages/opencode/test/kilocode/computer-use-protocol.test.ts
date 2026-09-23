import { describe, expect, test } from "bun:test"
import { Observation, ObservationID } from "../../src/kilocode/computer-use/protocol"
import { Schema } from "effect"

const target = { surface: "desktop" as const, windowID: "window-1", location: "scene-1" }

describe("Computer Use observation protocol", () => {
  test("accepts legacy observations and versioned scene continuity", () => {
    const base = {
      id: ObservationID.make("observation-1"),
      observedAt: 100,
      validUntil: 200,
      target,
    }

    expect(Schema.is(Observation)({ ...base, version: 1 })).toBe(true)
    expect(Schema.is(Observation)({ ...base, version: 2, sequence: 1, sceneVersion: 1 })).toBe(true)
    expect(Schema.is(Observation)({ ...base, version: 2 })).toBe(false)
    expect(Schema.is(Observation)({ ...base, version: 2, sequence: 0, sceneVersion: 1 })).toBe(false)
    expect(Schema.is(Observation)({ ...base, version: 2, sequence: 1, sceneVersion: 0 })).toBe(false)
  })
})
