import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/chat.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ToolRegistry } from "@kilocode/kilo-ui/message-part"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { registerExpandedTaskTool } from "../../webview-ui/src/components/chat/TaskToolExpanded"
window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: () => {} })
document.documentElement.setAttribute("data-theme", "kilo-vscode")
document.documentElement.style.setProperty("--vscode-font-family", "sans-serif")
registerExpandedTaskTool()
const Task = ToolRegistry.render("task")
const model = { providerID: "provider".repeat(64), modelID: "m".repeat(512) }
const variant = "v".repeat(512)
const receipt = {
  version: 1,
  stage: "selected",
  model,
  variant,
  source: "agent-config",
  variantSource: "model-override",
  capability: "normalized-provider-flag",
}
function Fixture() {
  const [metadata, set] = createSignal({ model, variant, provenance: receipt })
  return (
    <StoryProviders noPadding>
      <button onClick={() => set({ model })}>Legacy</button>
      <button onClick={() => set({ model, provenance: { ...receipt, version: 2 } })}>Malformed</button>
      <button onClick={() => set({ model, variant, provenance: receipt })}>Current</button>
      <div class="message-list">
        <Task
          tool="task"
          partID="provenance-fixture"
          status="completed"
          forceOpen
          input={{ description: "Review selection", subagent_type: "worker" }}
          metadata={metadata()}
          output=""
        />
      </div>
    </StoryProviders>
  )
}
render(() => <Fixture />, document.getElementById("root"))
