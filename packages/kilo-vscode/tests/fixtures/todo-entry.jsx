import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import "../../webview-ui/preview/preview.css"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { TodoView } from "../../webview-ui/src/components/todo/TodoView"

const params = new URLSearchParams(location.search)
const state = params.get("state") ?? "populated"
const messages = []
let offline = state === "offline"
let stale = state === "stale"
let items =
  state === "empty" || state === "loading" || state === "offline"
    ? []
    : [
        {
          id: "todo-open",
          title: "Review the launch checklist",
          done: false,
          revision: 1,
          createdAt: 10,
          updatedAt: 30,
        },
        { id: "todo-done", title: "Confirm the release owner", done: true, revision: 1, createdAt: 5, updatedAt: 20 },
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
    if (message.type === "personalTodoList") {
      if (state === "loading") return
      if (offline) {
        offline = false
        emit({
          type: "personalTodoResult",
          requestID: message.requestID,
          operation: "list",
          error: { kind: "offline", message: "Raya is offline. Reconnect to load your todos." },
        })
        return
      }
      emit({ type: "personalTodoResult", requestID: message.requestID, operation: "list", items })
      return
    }
    if (message.type === "personalTodoCreate") {
      const item = {
        id: `todo-${items.length + 1}`,
        title: message.title,
        done: false,
        revision: 1,
        createdAt: 40 + items.length,
        updatedAt: 40 + items.length,
      }
      items = [...items, item]
      emit({ type: "personalTodoResult", requestID: message.requestID, operation: "create", item })
      return
    }
    if (message.type === "personalTodoUpdate") {
      const current = items.find((item) => item.id === message.todoID)
      if (!current) return
      if (stale) {
        stale = false
        const latest = { ...current, revision: 2, updatedAt: 50 }
        items = items.map((item) => (item.id === latest.id ? latest : item))
        emit({
          type: "personalTodoResult",
          requestID: message.requestID,
          operation: "update",
          error: {
            kind: "stale",
            message: "This todo changed since you loaded it.",
            expected: message.revision,
            actual: latest.revision,
            latest,
          },
        })
        return
      }
      const item = { ...current, done: message.done, revision: current.revision + 1, updatedAt: 60 }
      items = items.map((row) => (row.id === item.id ? item : row))
      emit({ type: "personalTodoResult", requestID: message.requestID, operation: "update", item })
      return
    }
    if (message.type === "personalTodoDelete") {
      items = items.filter((item) => item.id !== message.todoID)
      emit({
        type: "personalTodoResult",
        requestID: message.requestID,
        operation: "delete",
        todoID: message.todoID,
        removed: true,
      })
    }
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
    ? { background: "#f5f5f5", foreground: "#222222", weak: "#595959", focus: "#45557a" }
    : theme === "contrast"
      ? { background: "#000000", foreground: "#ffffff", weak: "#ffffff", focus: "#ffff00" }
      : { background: "#1c1c1c", foreground: "#f1f1f1", weak: "#b8b8b8", focus: "#9ab0d6" }
for (const [key, value] of Object.entries({
  "editor-background": colors.background,
  "sideBar-background": colors.background,
  foreground: colors.foreground,
  descriptionForeground: colors.weak,
  "input-background": colors.background,
  "input-foreground": colors.foreground,
  "input-placeholderForeground": colors.weak,
  "input-border": colors.weak,
  focusBorder: colors.focus,
  contrastBorder: theme === "contrast" ? colors.foreground : "transparent",
  "button-background": theme === "contrast" ? "#000000" : "#55698f",
  "button-foreground": "#ffffff",
  "button-hoverBackground": theme === "contrast" ? "#1f1f1f" : "#647ba6",
  "list-hoverBackground": theme === "contrast" ? "#1f1f1f" : "#2b2b2b",
  errorForeground: theme === "contrast" ? "#ffffff" : "#f48771",
}))
  document.body.style.setProperty(`--vscode-${key}`, value)
document.body.style.background = colors.background
document.body.style.color = colors.foreground

render(
  () => (
    <StoryProviders noPadding config={{}}>
      <TodoView onBack={() => {}} />
      <output data-messages hidden>
        {JSON.stringify(messages)}
      </output>
    </StoryProviders>
  ),
  document.getElementById("root"),
)
