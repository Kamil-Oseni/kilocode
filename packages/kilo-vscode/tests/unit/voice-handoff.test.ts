import { expect, test } from "bun:test"
import { valid, ack, quiet, same, event, command } from "../../src/shared/voice-handoff"

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

test("prepared and cutover acknowledgements retain the complete strict identity", () => {
  for (const phase of ["prepared", "cutover"] as const) {
    expect(ack({ ...identity, phase }, phase)).toBe(true)
    for (const value of [
      identity,
      { ...identity, phase: "other" },
      { ...identity, phase, secret: "private" },
      { ...identity, phase, id: undefined },
      { ...identity, phase, epoch: 0 },
    ])
      expect(ack(value, phase)).toBe(false)
  }
})

test("quiescence requires an exact bounded activity epoch without extra fields", () => {
  expect(quiet({ ...identity, phase: "quiesced", epoch: 0 })).toBe(true)
  for (const epoch of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null, undefined])
    expect(quiet({ ...identity, phase: "quiesced", epoch })).toBe(false)
  expect(quiet({ ...identity, phase: "quiesced", epoch: 1, secret: "private" })).toBe(false)
  expect(quiet({ ...identity, source: identity.target, phase: "quiesced", epoch: 1 })).toBe(false)
})

test("every field participates in matching a handoff identity", () => {
  const original = { ...identity, version: 1 as const }
  expect(same(original, { ...original })).toBe(true)
  for (const field of ["id", "sessionID", "source", "target"] as const)
    expect(same(original, { ...original, [field]: "different" })).toBe(false)
})

test("handoff bridge messages reject extra authority fields and malformed acknowledgements", () => {
  const messages = [
    { type: "speechOpenAIHandoffOffer", handoff: identity, sdp: "offer" },
    { type: "speechOpenAIHandoffPrepared", ack: { ...identity, phase: "prepared" } },
    { type: "speechOpenAIHandoffQuiesced", quiet: { ...identity, phase: "quiesced", epoch: 1 } },
    { type: "speechOpenAIHandoffCutoverAck", ack: { ...identity, phase: "cutover" } },
    { type: "speechOpenAIHandoffRetired", handoff: identity, confirmed: false },
    { type: "speechOpenAIHandoffCancel", handoff: identity, reason: "activity" },
  ]
  for (const message of messages) {
    expect(event(message)).toBe(true)
    expect(event({ ...message, capability: "private" })).toBe(false)
  }
  expect(event({ ...messages[0], sdp: "" })).toBe(false)
  expect(event({ ...messages[0], sdp: "a".repeat(262_145) })).toBe(false)
  expect(event({ ...messages[4], confirmed: "true" })).toBe(false)
  expect(event({ ...messages[5], reason: { toString: () => "activity" } })).toBe(false)
  expect(event({ type: "speechOpenAIHandoffPrepared", ack: { ...identity, phase: "cutover" } })).toBe(false)
})

test("host commands carry bounded media data and explicit restore authority", () => {
  const messages = [
    { type: "speechOpenAIHandoffPrepare", handoff: identity },
    { type: "speechOpenAIHandoffAnswer", handoff: identity, sdp: "answer" },
    { type: "speechOpenAIHandoffQuiesce", handoff: identity },
    { type: "speechOpenAIHandoffCutover", quiet: { ...identity, phase: "quiesced", epoch: 1 } },
    { type: "speechOpenAIHandoffRetire", handoff: identity },
    { type: "speechOpenAIHandoffCancel", handoff: identity, restore: false },
  ]
  for (const message of messages) {
    expect(command(message)).toBe(true)
    expect(command({ ...message, extra: true })).toBe(false)
  }
  expect(command({ ...messages[5], restore: "true" })).toBe(false)
  expect(command({ type: "speechOpenAIHandoffCancel", handoff: identity })).toBe(false)
  expect(command({ ...messages[1], sdp: "a".repeat(262_145) })).toBe(false)
  expect(command({ type: "unknown", handoff: identity })).toBe(false)
})
