import { expect, test } from "bun:test"
import { draftNotice } from "../../webview-ui/src/utils/draft-notice"

test("failed hydration explains loading without claiming edits were saved", () => {
  expect(draftNotice({ loaded: false, error: "timeout" })).toEqual({
    text: "Loading your saved draft took too long. Retry before sending.",
    action: "Retry loading",
  })
  expect(draftNotice({ loaded: false, error: "unavailable" })).toEqual({
    text: "Your saved draft could not be loaded. Retry before sending.",
    action: "Retry loading",
  })
})

test("ownership refusal explains verification and failed save keeps explicit retry", () => {
  expect(draftNotice({ loaded: false, error: "scope" })).toEqual({
    text: "Raya could not verify this chat's draft. Retry before sending.",
    action: "Retry loading",
  })
  expect(draftNotice({ loaded: true, error: "timeout" })).toEqual({
    text: "Saving your draft took too long to confirm. Your edits are still here. Retry saving.",
    action: "Retry saving",
  })
})

test("connection changes retain the correct loading or saving recovery phase", () => {
  const loading = draftNotice({ loaded: false, error: "disconnected" })
  const saving = draftNotice({ loaded: true, error: "disconnected" })
  expect(loading.action).toBe("Retry loading")
  expect(loading.text).toContain("before your saved draft could load")
  expect(loading.text).not.toContain("Your edits are still here")
  expect(saving.action).toBe("Retry saving")
  expect(saving.text).toContain("before your draft save was confirmed")
  expect(saving.text).toContain("Your edits are still here")
  expect(draftNotice({ loaded: true, error: "unavailable" }).text).toContain("Check System Health")
})
