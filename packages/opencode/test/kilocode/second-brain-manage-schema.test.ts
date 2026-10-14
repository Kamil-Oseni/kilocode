import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Params, schema } from "@/kilocode/tool/second-brain-manage"
import { Params as Management, command } from "@/kilocode/second-brain/management"
import { digest } from "@/kilocode/second-brain/management-source"

function source(text: string) {
  const original = { sessionID: "ses_user", messageID: "msg_user", created_utc: "2026-10-14T11:00:00.000Z", text }
  return { ...original, source_sha256: digest(original) }
}

test("model-facing personal management admits only an action and refuses discarded paraphrases", () => {
  expect(Object.keys(schema.properties ?? {})).toEqual(["action"])
  expect(schema.required).toEqual(["action"])
  expect(schema.additionalProperties).toBe(false)
  const decode = Schema.decodeUnknownSync(Params)
  for (const action of ["remember", "correct", "forget"] as const) expect(decode({ action })).toEqual({ action })
  for (const input of [
    {},
    { action: "publish" },
    { action: "remember", text: "Invented replacement" },
    { action: "forget", query: "Different target" },
    { action: "remember", approved: true },
  ])
    expect(() => decode(input)).toThrow()
})

test("action-only requests derive original facts and targets while legacy evidence checks remain strict", () => {
  const decode = Schema.decodeUnknownSync(Params)
  const original = source(
    "Record this outcome in my Raya project memory: Memory is connected; saving is still under test.",
  )
  const value = command(original, decode({ action: "remember" }))
  expect(original.text.slice(value.fact!.start, value.fact!.end)).toBe(
    "Memory is connected; saving is still under test",
  )
  const corrected = command(source("Correct my drink preference to tea."), decode({ action: "correct" }))
  expect(corrected.query).toBe("drink preference")
  expect(command(source("Forget my drink preference."), decode({ action: "forget" })).query).toBe("drink preference")
  const legacy = Schema.decodeUnknownSync(Management)({ action: "remember", text: "I prefer coffee" })
  expect(() => command(original, legacy)).toThrow("exact original")
  expect(() => command(original, { action: "remember", query: "other" })).toThrow("original request")
  expect(() => command(source("Change my lights to red."), decode({ action: "remember" }))).toThrow("No Memory change")
})
