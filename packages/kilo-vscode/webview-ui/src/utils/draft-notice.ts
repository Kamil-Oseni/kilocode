import type { DraftCode } from "../../../src/shared/composer-drafts-messages"

export function draftNotice(state: { loaded: boolean; error?: DraftCode }) {
  const action = state.loaded ? "Retry saving" : "Retry loading"
  if (state.error === "scope" || state.error === "stale" || state.error === "invalid")
    return { text: "Raya could not verify this chat's draft. Retry before sending.", action }
  if (state.error === "disconnected")
    return {
      text: state.loaded
        ? "Raya's connection changed before your draft save was confirmed. Your edits are still here. Retry after reconnecting."
        : "Raya's connection changed before your saved draft could load. Retry after reconnecting before sending.",
      action,
    }
  if (!state.loaded)
    return {
      text:
        state.error === "timeout"
          ? "Loading your saved draft took too long. Retry before sending."
          : "Your saved draft could not be loaded. Retry before sending.",
      action,
    }
  if (state.error === "timeout")
    return { text: "Saving your draft took too long to confirm. Your edits are still here. Retry saving.", action }
  if (state.error === "unavailable")
    return {
      text: "Raya's backend could not confirm your draft save. Your edits are still here. Check System Health, then retry saving.",
      action,
    }
  return { text: "Raya could not confirm your draft was saved. Your edits are still here.", action }
}
