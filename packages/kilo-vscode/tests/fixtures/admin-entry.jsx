import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import "../../webview-ui/preview/preview.css"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { AdminView } from "../../webview-ui/src/components/admin/AdminView"

const params = new URLSearchParams(location.search)
const state = params.get("state") ?? "healthy"
const messages = []
let attempts = 0
const ids = [
  "runtime",
  "sessions",
  "goals",
  "routines",
  "organizations",
  "scheduler",
  "agents",
  "skills",
  "todos",
  "contacts",
  "browser",
  "computer",
  "voice",
  "memory",
  "canvas",
  "sync",
  "updates",
]
const stamp = Date.UTC(2026, 8, 15, 14, 30)
const healthy = ids.map((id) => ({ id, status: "healthy", reason: "ready", observedAt: stamp }))
const health = (items = healthy) => ({ format: "raya.admin-health", version: 2, generatedAt: stamp, items })
const entry = (index) => ({
  at: stamp - index * 60_000,
  level: index % 7 === 0 ? "warn" : "info",
  subsystem: ids[index % ids.length],
  code: index % 7 === 0 ? "probe.retry" : "probe.complete",
  fields: {
    durationMs: 8 + index,
    count: index + 1,
    attempt: (index % 3) + 1,
    generation: 4,
    state: index % 7 === 0 ? "degraded" : "healthy",
    reason: index % 7 === 0 ? "probe-failed" : "ready",
    source: ids[index % ids.length],
    version: `1.${index}`,
  },
})
const logs = [
  {
    ...entry(0),
    code: "contact.authorized",
    fields: { source: "routines", channel: "raya", scope: "agent" },
  },
  entry(1),
  entry(2),
]

const emit = (message) => queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data: message })))
const record = (message) => {
  messages.push(message)
  const output = document.querySelector("[data-messages]")
  if (output) output.textContent = JSON.stringify(messages)
}

window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => {
    record(message)
    if (message.type !== "requestAdmin") return
    attempts += 1
    if (state === "loading") return
    if (state === "retry" && attempts === 1) {
      emit({
        type: "adminResult",
        requestID: message.requestID,
        error: { kind: "error", message: "System health could not be checked. Try again." },
      })
      return
    }
    if (state === "partial") {
      emit({
        type: "adminResult",
        requestID: message.requestID,
        health: health([
          healthy[0],
          healthy[1],
          healthy[2],
          { id: "routines", status: "degraded", reason: "routine-recovery", observedAt: stamp },
          ...healthy.slice(4, 15),
        ]),
        logs,
      })
      return
    }
    if (state === "logs-error") {
      emit({
        type: "adminResult",
        requestID: message.requestID,
        health: health(),
        error: { kind: "error", message: "Recent diagnostics could not be loaded. Health status is still current." },
      })
      return
    }
    emit({
      type: "adminResult",
      requestID: message.requestID,
      health: health(),
      logs: state === "empty" ? [] : state === "long" ? Array.from({ length: 48 }, (_, index) => entry(index)) : logs,
    })
  },
})

const theme = params.get("theme") ?? "dark"
document.body.className =
  theme === "light" ? "vscode-light" : theme === "contrast" ? "vscode-high-contrast" : "vscode-dark"
document.documentElement.setAttribute("data-theme", "kilo-vscode")
document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark"
document.body.classList.add(theme === "light" ? "pv-theme--light" : "pv-theme--dark")
const colors =
  theme === "light"
    ? {
        background: "#f5f5f5",
        foreground: "#222222",
        weak: "#595959",
        focus: "#45557a",
        warning: "#795e26",
        error: "#a31515",
      }
    : theme === "contrast"
      ? {
          background: "#000000",
          foreground: "#ffffff",
          weak: "#ffffff",
          focus: "#ffff00",
          warning: "#ffffff",
          error: "#ffffff",
        }
      : {
          background: "#1c1c1c",
          foreground: "#f1f1f1",
          weak: "#b8b8b8",
          focus: "#9ab0d6",
          warning: "#cca700",
          error: "#f48771",
        }
for (const [key, value] of Object.entries({
  "editor-background": colors.background,
  "sideBar-background": colors.background,
  foreground: colors.foreground,
  descriptionForeground: colors.weak,
  focusBorder: colors.focus,
  contrastBorder: theme === "contrast" ? colors.foreground : "transparent",
  "button-background": theme === "contrast" ? "#000000" : "#55698f",
  "button-foreground": "#ffffff",
  "button-hoverBackground": theme === "contrast" ? "#1f1f1f" : "#647ba6",
  "testing-iconPassed": theme === "contrast" ? colors.foreground : "#2d8a50",
  "editorWarning-foreground": colors.warning,
  errorForeground: colors.error,
  "panel-border": colors.weak,
}))
  document.body.style.setProperty(`--vscode-${key}`, value)
document.body.style.background = colors.background
document.body.style.color = colors.foreground

render(
  () => (
    <StoryProviders noPadding config={{}}>
      <AdminView onBack={() => record({ type: "back" })} />
      <output data-messages hidden>
        {JSON.stringify(messages)}
      </output>
    </StoryProviders>
  ),
  document.getElementById("root"),
)

if (state !== "disconnected") emit({ type: "connectionState", state: "connected" })
