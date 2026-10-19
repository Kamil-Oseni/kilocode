import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import { render } from "solid-js/web"
import { VSCodeProvider } from "../../webview-ui/src/context/vscode"
import { OutputReview } from "../../webview-ui/src/components/routines/OutputReview"

// Only the external VS Code wire is injected; the editor and conditional save are production components.
const messages = []
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => {
    messages.push(message)
    document.body.dataset.messages = JSON.stringify(messages)
  },
})
window.final = {
  reply: (data) => window.dispatchEvent(new MessageEvent("message", { data })),
}
render(
  () => (
    <VSCodeProvider>
      <OutputReview
        item={{
          id: "routine",
          name: "Exact answer",
          output: {
            destination: "conversation",
            description: "Report",
            criteria: [{ id: "exact", description: "Match", verification: "Compare bytes" }],
          },
        }}
        onClose={() => {}}
      />
    </VSCodeProvider>
  ),
  document.getElementById("root"),
)
