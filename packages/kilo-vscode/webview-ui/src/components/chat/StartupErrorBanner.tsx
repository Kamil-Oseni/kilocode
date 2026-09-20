/**
 * StartupErrorBanner
 * Shown in the chat view when the CLI server fails to start.
 */

import { Component, createSignal, Show } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { recoveryCopy } from "../../utils/recovery-copy"

interface StartupErrorBannerProps {
  errorMessage: string
  errorDetails: string
}

export const StartupErrorBanner: Component<StartupErrorBannerProps> = (props) => {
  const language = useLanguage()
  const vscode = useVSCode()
  const [expanded, setExpanded] = createSignal(false)

  const retry = () => {
    vscode.postMessage({ type: "retryConnection" })
  }

  return (
    <div class="startup-error-banner">
      <div class="startup-error-header">
        <button
          type="button"
          class="startup-error-disclosure"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded()}
        >
          <span class={`startup-error-chevron${expanded() ? " startup-error-chevron-expanded" : ""}`}>
            <Icon name="chevron-right" size="small" />
          </span>
          <span class="startup-error-title">
            {language.t("error.startup.title")}: <span class="startup-error-firstline">{props.errorMessage}</span>
            <span class="startup-error-recovery">
              {recoveryCopy.startup.preserved} {recoveryCopy.startup.next}
            </span>
          </span>
        </button>
        <button
          type="button"
          class="startup-error-retry"
          onClick={retry}
          aria-label={language.t("common.retry")}
        >
          {language.t("common.retry")}
        </button>
      </div>
      <Show when={expanded()}>
        <pre class="startup-error-details">{props.errorDetails}</pre>
      </Show>
    </div>
  )
}
