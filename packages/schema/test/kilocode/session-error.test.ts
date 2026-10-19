import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../../src/event-manifest"
import { SessionV1 } from "../../src/v1/session"

test("canonical session error preserves original submission identity and omits absent IDs", () => {
  const definition = EventManifest.Latest.get("session.error")
  expect(definition).toBe(SessionV1.Event.Error)
  if (!definition) throw new Error("Canonical session error definition missing")
  const decode = Schema.decodeUnknownSync(SessionV1.Event.Error.data)
  const encode = Schema.encodeSync(SessionV1.Event.Error.data)
  const legacy = {
    sessionID: "ses_failure",
    error: { name: "UnknownError" as const, data: { message: "Pre-intake failure" } },
  }
  const missing = encode(decode(legacy))
  expect(missing).toEqual(legacy)
  expect(Object.hasOwn(missing, "messageID")).toBe(false)
  expect(Object.hasOwn(encode({ ...decode(legacy), messageID: undefined }), "messageID")).toBe(false)
  const original = { ...legacy, messageID: "msg_original" }
  expect(encode(decode(original))).toEqual(original)
  // The actual public manifest encoder must retain the field too, rather than strip runtime-only data.
  const manifest = Schema.encodeSync(definition.data)
  expect(manifest(decode(original))).toEqual(original)
})
