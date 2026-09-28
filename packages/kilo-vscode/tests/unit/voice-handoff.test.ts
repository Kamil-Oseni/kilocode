import { expect, test } from "bun:test"
import { valid } from "../../src/shared/voice-handoff"

const identity = { version: 1, id: "handoff_1", sessionID: "ses_parent", source: "source_1", target: "candidate_1" }

test("media handoff admits only a complete versioned identity with distinct operations", () => {
  expect(valid(identity)).toBe(true)
  for (const value of [
    undefined,
    null,
    [],
    "handoff_1",
    {},
    { ...identity, version: 2 },
    { ...identity, source: identity.target },
    { ...identity, capability: "private" },
    { ...identity, phase: "prepared" },
    Object.assign(Object.create({ version: 1 }), {
      id: identity.id,
      sessionID: identity.sessionID,
      source: identity.source,
      target: identity.target,
      extra: true,
    }),
  ])
    expect(valid(value)).toBe(false)
})

test("every handoff identity field is bounded and cannot be omitted or coerced", () => {
  for (const key of ["id", "sessionID", "source", "target"] as const) {
    for (const value of [undefined, null, 7, "", "a".repeat(129), "wrong id", "id\n", "秘密", {}])
      expect(valid({ ...identity, [key]: value })).toBe(false)
  }
})
