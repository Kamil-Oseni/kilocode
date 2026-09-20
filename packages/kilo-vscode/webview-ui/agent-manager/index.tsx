// Agent Manager SolidJS entry point
// Shares components and providers with the sidebar webview
// webviewReady is sent by ServerProvider inside the component tree

import { ErrorBoundary, type Component } from "solid-js"
import { render } from "solid-js/web"
import "@kilocode/kilo-ui/styles"
import "../src/styles/chat.css"
import { registerExpandedTaskTool } from "../src/components/chat/TaskToolExpanded"
import { registerVscodeToolOverrides } from "../src/components/chat/VscodeToolOverrides"
import { getVSCodeAPI } from "../src/context/vscode"
import { AgentManagerApp } from "./AgentManagerApp"

const root = document.getElementById("root")
let ready = false

function detail(value: unknown) {
  if (value instanceof Error) return (value.stack ?? value.message).slice(0, 4_000)
  if (typeof value === "string") return value.slice(0, 4_000)
  return "Agent Manager stopped before its interface was ready."
}

function note(source: string, value: unknown) {
  const message = detail(value)
  console.error(`[Raya] Agent Manager ${source} failure`, value)
  try {
    getVSCodeAPI().postMessage({ type: "agentManager.webviewError", source, message })
  } catch (err) {
    console.error("[Raya] Agent Manager could not report its startup failure", err)
  }
  return message
}

const Failure: Component<{ source: string; error: unknown }> = (props) => {
  const message = note(props.source, props.error)
  return (
    <main class="am-startup-error" role="alert">
      <div class="am-startup-error-copy">
        <h1>Agent Manager couldn't open</h1>
        <p>Your sessions and worktrees are still saved. Reload the window, then open Agent Manager again.</p>
        <details>
          <summary>Technical details</summary>
          <pre>{message}</pre>
        </details>
      </div>
    </main>
  )
}

function show(source: string, error: unknown) {
  if (!root) return
  render(() => <Failure source={source} error={error} />, root)
}

window.addEventListener("error", (event) => {
  if (!ready) show("window", event.error ?? event.message)
})
window.addEventListener("unhandledrejection", (event) => {
  if (!ready) show("promise", event.reason)
})

if (root) {
  try {
    registerExpandedTaskTool()
    registerVscodeToolOverrides()
    render(
      () => (
        <ErrorBoundary fallback={(error) => <Failure source="render" error={error} />}>
          <AgentManagerApp />
        </ErrorBoundary>
      ),
      root,
    )
    ready = true
  } catch (err) {
    show("bootstrap", err)
  }
}
