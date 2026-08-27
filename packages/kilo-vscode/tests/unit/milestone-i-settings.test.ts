// raya_change - Milestone I settings surface contract
import { describe, expect, it } from "bun:test"
import path from "path"

const root = path.join(__dirname, "../../webview-ui/src/components")

describe("Milestone I settings", () => {
  it("renders an explicit model-list connection test with green success state", async () => {
    const source = await Bun.file(path.join(root, "settings/CustomProviderDialog.tsx")).text()

    expect(source).toContain('language.t("provider.custom.connection.test")')
    expect(source).toContain("doFetch(true)")
    expect(source).toContain("vscode-testing-iconPassed")
    expect(source).toContain('type: "fetchCustomProviderModels"')
  })

  it("offers the searchable model picker for every visible primary agent and subagent", async () => {
    const models = await Bun.file(path.join(root, "settings/ModelsTab.tsx")).text()
    const selector = await Bun.file(path.join(root, "shared/ModelSelector.tsx")).text()

    expect(models).toContain("session.allAgents().filter((agent) => !agent.hidden)")
    expect(models).toContain("<For each={allAgents()}>")
    expect(models).toContain("<ModelSelectorBase")
    expect(selector).toContain('class="model-selector-search"')
    expect(selector).toContain("rankModelSearch")
  })

  // raya_change - Milestones H/I complete the settings hub
  it("keeps Raya's primary settings ahead of a preserved Advanced group", async () => {
    const settings = await Bun.file(path.join(root, "settings/Settings.tsx")).text()
    const speech = await Bun.file(path.join(root, "settings/SpeechTab.tsx")).text()
    const routing = await Bun.file(path.join(root, "settings/GoalsRoutingTab.tsx")).text()
    const models = await Bun.file(path.join(root, "settings/ModelsTab.tsx")).text()
    const i18n = await Bun.file(path.join(root, "../i18n/en.ts")).text()

    const providers = settings.indexOf('<Tabs.Trigger value="providers"')
    const agents = settings.indexOf('<Tabs.Trigger value="models"')
    const speechNav = settings.indexOf('<Tabs.Trigger value="speech"')
    const routingNav = settings.indexOf('<Tabs.Trigger value="goalsRouting"')
    const advanced = settings.indexOf('class="settings-nav-group label"')
    const behaviour = settings.indexOf('<Tabs.Trigger value="agentBehaviour"')

    expect(providers).toBeGreaterThan(-1)
    expect(providers).toBeLessThan(agents)
    expect(agents).toBeLessThan(speechNav)
    expect(speechNav).toBeLessThan(routingNav)
    expect(routingNav).toBeLessThan(advanced)
    expect(advanced).toBeLessThan(behaviour)
    for (const tab of [
      "agentBehaviour",
      "autoApprove",
      "agentManager",
      "browser",
      "checkpoints",
      "display",
      "autocomplete",
      "notifications",
      "context",
      "commitMessage",
      "indexing",
      "experimental",
      "sandboxing",
      "language",
      "aboutKiloCode",
    ]) {
      expect(settings.indexOf(`<Tabs.Trigger value="${tab}"`)).toBeGreaterThan(advanced)
    }
    expect(settings).toContain('language.t("settings.navigation.advanced")')
    expect(i18n).toContain('"settings.speech.title": "Speech"')
    expect(i18n).toContain('"settings.goalsRouting.title": "Goals & routing"')
    expect(speech).toContain("sttEndpoint")
    expect(speech).toContain("ttsModel")
    expect(speech).toContain('type="password"')
    expect(models).not.toContain("speech_to_text_model")
    expect(models).not.toContain("hasSpeechToTextAccess")
    expect(routing).toContain("confidence_threshold")
    expect(routing).toContain("goal_continuation")
  })

  // raya_change - Chief model uses the searchable catalog and null means inherit.
  it("selects and clears the Chief small model through ModelSelectorBase", async () => {
    const routing = await Bun.file(path.join(root, "settings/GoalsRoutingTab.tsx")).text()

    expect(routing).toContain('import { ModelSelectorBase } from "../shared/ModelSelector"')
    expect(routing).toContain("value={parseModelString(config().small_model ?? undefined)}")
    expect(routing).toContain("updateConfig({ small_model: `${providerID}/${modelID}` })")
    expect(routing).toContain("updateConfig({ small_model: null })")
    expect(routing).toContain("allowClear")
    expect(routing).toContain("includeAutoSmall")
    expect(routing).not.toContain("small_model.trim()")
  })

  // raya_change - the fresh-install transfer keeps config ownership and speech preferences without key state.
  it("exports and restores scoped non-secret settings through the hub", async () => {
    const about = await Bun.file(path.join(root, "settings/AboutKiloCodeTab.tsx")).text()
    const transfer = await Bun.file(path.join(root, "settings/settings-io.ts")).text()

    expect(about).toContain("global: globalConfig()")
    expect(about).toContain("project: projectConfig()")
    expect(about).toContain("speech: voice.settings()")
    expect(about).toContain("updateGlobalConfig(result.scopes.global)")
    expect(about).toContain("updateProjectConfig(result.scopes.project)")
    expect(about).toContain("voice.update(result.speech)")
    expect(transfer).toContain("secretsStripped: true")
    expect(transfer).toContain("const SPEECH_KEYS")
    expect(transfer).not.toContain("hasSttKey")
    expect(transfer).not.toContain("hasTtsKey")
  })
})
