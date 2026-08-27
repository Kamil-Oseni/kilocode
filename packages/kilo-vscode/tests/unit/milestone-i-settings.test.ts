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
  it("exposes Speech and Goals & routing panels backed by runtime settings", async () => {
    const settings = await Bun.file(path.join(root, "settings/Settings.tsx")).text()
    const speech = await Bun.file(path.join(root, "settings/SpeechTab.tsx")).text()
    const routing = await Bun.file(path.join(root, "settings/GoalsRoutingTab.tsx")).text()
    const models = await Bun.file(path.join(root, "settings/ModelsTab.tsx")).text()

    expect(settings).toContain('value="speech"')
    expect(settings).toContain('value="goalsRouting"')
    expect(speech).toContain("sttEndpoint")
    expect(speech).toContain("ttsModel")
    expect(speech).toContain('type="password"')
    expect(models).not.toContain("speech_to_text_model")
    expect(models).not.toContain("hasSpeechToTextAccess")
    expect(routing).toContain("confidence_threshold")
    expect(routing).toContain("goal_continuation")
  })
})
