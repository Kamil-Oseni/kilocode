/**
 * WorkingIndicator component
 * Shows shimmering status text while the agent is active.
 * Purely visual: `SessionDock` decides when this renders (see `showsWorking`).
 * Keeping the decision in one place is what stops the dock from resizing when
 * a turn starts or ends.
 */

import { type Component, Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { StatusText } from "./StatusText"

export const WorkingIndicator: Component = () => {
  const session = useSession()
  const language = useLanguage()
  const vscode = useVSCode()

  const [retryCountdown, setRetryCountdown] = createSignal(0)

  createEffect(() => {
    const info = session.statusInfo()
    if (info.type !== "retry") {
      setRetryCountdown(0)
      return
    }

    const target = info.next
    setRetryCountdown(Math.max(0, Math.ceil((target - Date.now()) / 1000)))

    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000))
      setRetryCountdown(remaining)
      if (remaining <= 0) clearInterval(id)
    }, 1000)

    onCleanup(() => clearInterval(id))
  })

  // Memoized so an unchanged label never reaches `StatusText`: the status is
  // recomputed on every streamed part, and each pass through would otherwise
  // replay the swap animation.
  const statusText = createMemo(() => {
    const info = session.statusInfo()
    if (info.type === "retry") return info.message || language.t("session.status.retry")
    if (info.type === "offline") return info.message || language.t("session.status.offline")
    return session.statusText() ?? language.t("ui.sessionTurn.status.thinking")
  })

  const isRetrying = () => session.statusInfo().type === "retry"

  const handleCancelRetry = () => {
    const sid = session.currentSessionID()
    if (sid) {
      vscode.postMessage({ type: "abort", sessionID: sid })
    }
  }

  return (
    <div class="working-indicator">
      <StatusText text={statusText()} />
      {/* Kept out of the label: a countdown inside the morphing text would swap it
          once a second, and every tick would read as a new status. */}
      <Show when={isRetrying() && retryCountdown() > 0}>
        <span class="working-count">({retryCountdown()}s)</span>
      </Show>
      <Show when={isRetrying()}>
        <Button
          variant="secondary"
          size="small"
          onClick={handleCancelRetry}
          class="working-cancel"
          style={{ "font-weight": "600", color: "var(--vscode-errorForeground, #f85149)" }}
        >
          {language.t("ui.sessionTurn.cancel") || "Cancel"}
        </Button>
      </Show>
    </div>
  )
}
