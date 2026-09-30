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
    text: "Raya could not confirm your draft was saved. Your edits are still here.",
    action: "Retry saving",
  })
})
