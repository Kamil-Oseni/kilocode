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
})
