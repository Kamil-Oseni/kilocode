// raya_change - Milestone I Goals & routing panel consumed by Milestones A/B
import { Card } from "@kilocode/kilo-ui/card"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import type { Component } from "solid-js"
import { parseModelString } from "../../../../src/shared/provider-model"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { ModelSelectorBase } from "../shared/ModelSelector"
import SettingsRow from "./SettingsRow"

const GoalsRoutingTab: Component = () => {
  const { config, updateConfig } = useConfig()
  const language = useLanguage()
  const routing = () => config().raya_routing ?? {}

  // raya_change start - Use the provider-backed picker while retaining small_model inheritance semantics.
  const select = (providerID: string, modelID: string) => {
    if (!providerID || !modelID) {
      updateConfig({ small_model: null })
      return
    }
    updateConfig({ small_model: `${providerID}/${modelID}` })
  }
  // raya_change end

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
      <p style={{ margin: 0, color: "var(--vscode-descriptionForeground)", "font-size": "var(--kilo-font-size-12)" }}>
        Configure the fast Chief that routes plain-English requests and the default behavior of persistent goals.
      </p>
      <Card>
        <SettingsRow title="Chief model" description="Fast, inexpensive provider/model used by Auto before delegation.">
          {/* raya_change - Clearing the Chief model inherits the resolved default small model. */}
          <ModelSelectorBase
            value={parseModelString(config().small_model ?? undefined)}
            onSelect={select}
            placement="bottom-start"
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            includeAutoSmall
            label="Chief model"
            description="Fast, inexpensive provider/model used by Auto before delegation."
          />
        </SettingsRow>
        <SettingsRow
          title="Confidence threshold"
          description="Below this value, Auto asks with selectable options instead of guessing."
        >
          <TextField
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={String(routing().confidence_threshold ?? 0.7)}
            onChange={(value) =>
              updateConfig({
                raya_routing: {
                  ...routing(),
                  confidence_threshold: Math.min(1, Math.max(0, Number(value) || 0)),
                },
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          title="Automatic goal continuation"
          description="Continue active goals when the thread becomes idle; no-tool and blocked safeguards still apply."
          last
        >
          <Switch
            checked={routing().goal_continuation !== false}
            onChange={(goal_continuation) => updateConfig({ raya_routing: { ...routing(), goal_continuation } })}
            hideLabel
          >
            Automatic goal continuation
          </Switch>
        </SettingsRow>
      </Card>
    </div>
  )
}

export default GoalsRoutingTab
