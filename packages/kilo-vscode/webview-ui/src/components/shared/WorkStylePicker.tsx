import { For, Show } from "solid-js"
import type { Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { useWorkStyle } from "../../context/work-style"

const details = ["permissions", "visibility"] as const
const recommended = "human-in-the-loop" as const

export const WorkStylePicker: Component = () => {
  const language = useLanguage()
  const vscode = useVSCode()
  const work = useWorkStyle()
  const open = (event: MouseEvent) => {
    event.preventDefault()
    vscode.postMessage({ type: "openSettingsPanel", tab: "autoApprove" })
  }

  return (
    <section class="work-style-picker" aria-labelledby="work-style-title">
      <h2 id="work-style-title" data-slot="work-style-title">
        {language.t("workStyle.onboarding.title")}
      </h2>

      <div data-slot="work-style-recommendation">
        <p data-slot="work-style-mode-description">{language.t(`workStyle.choice.${recommended}.description`)}</p>
        <ul data-slot="work-style-mode-details">
          <For each={details}>{(detail) => <li>{language.t(`workStyle.choice.${recommended}.${detail}`)}</li>}</For>
        </ul>
      </div>

      <Show when={work.error()}>
        {(error) => (
          <p class="work-style-error" role="alert">
            <strong>{language.t("common.requestFailed")}.</strong> {error()}
          </p>
        )}
      </Show>

      <Button
        class="work-style-mode"
        variant="primary"
        disabled={work.applying()}
        onClick={() => work.apply(recommended)}
      >
        {language.t(`workStyle.choice.${recommended}.title`)}
      </Button>

      <p data-slot="work-style-settings-note">
        <span>{language.t("workStyle.onboarding.settingsNote")}</span>
        <a href="#" onClick={open}>
          <Icon name="settings-gear" size="small" />
          <span>{language.t("workStyle.onboarding.settings")}</span>
        </a>
      </p>
    </section>
  )
}
