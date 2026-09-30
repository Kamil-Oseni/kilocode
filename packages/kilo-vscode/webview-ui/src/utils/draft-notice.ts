import type { DraftCode } from "../../../src/shared/composer-drafts-messages"

export function draftNotice(state: { loaded: boolean; error?: DraftCode }) {
  const action = state.loaded ? "Retry saving" : "Retry loading"
  if (state.error === "scope" || state.error === "stale" || state.error === "invalid")
    return { text: "Raya could not verify this chat's draft. Retry before sending.", action }
  if (!state.loaded)
    return {
      text:
        state.error === "timeout"
          ? "Loading your saved draft took too long. Retry before sending."
          : "Your saved draft could not be loaded. Retry before sending.",
      action,
    }
  return { text: "Raya could not confirm your draft was saved. Your edits are still here.", action }
}
