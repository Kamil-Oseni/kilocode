// raya_change - Milestone I Goals & routing panel consumed by Milestones A/B
import { Card } from "@kilocode/kilo-ui/card"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import type { Component } from "solid-js"
import { useConfig } from "../../context/config"
import SettingsRow from "./SettingsRow"

const GoalsRoutingTab: Component = () => {
  const { config, updateConfig } = useConfig()
  const routing = () => config().raya_routing ?? {}

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
      <p style={{ margin: 0, color: "var(--vscode-descriptionForeground)", "font-size": "var(--kilo-font-size-12)" }}>
        Configure the fast Chief that routes plain-English requests and the default behavior of persistent goals.
      </p>
      <Card>
        <SettingsRow title="Chief model" description="Fast, inexpensive provider/model used by Auto before delegation.">
          <TextField
            value={config().small_model ?? ""}
            placeholder="provider/fast-model"
            onChange={(small_model) => updateConfig({ small_model: small_model.trim() || undefined })}
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
