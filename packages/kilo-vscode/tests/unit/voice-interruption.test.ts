import { expect, test } from "bun:test"
import { cancelled } from "../../src/shared/voice-interruption"

test("only the exact owned inactive-response cancellation error is recoverable", () => {
  const events = new Set(["owned"])
  expect(cancelled({ error: { code: "response_cancel_not_active", event_id: "owned" } }, events)).toBe(true)
  for (const error of [
    undefined,
    [],
    "invalid",
    { code: "response_cancel_not_active", event_id: "other" },
    { code: "invalid_value", event_id: "owned" },
    { code: "response_cancel_not_active" },
  ])
    expect(cancelled({ error }, events)).toBe(false)
})
