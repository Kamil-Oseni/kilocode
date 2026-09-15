import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import "../../webview-ui/preview/preview.css"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { TodoView } from "../../webview-ui/src/components/todo/TodoView"

const params = new URLSearchParams(location.search)
const state = params.get("state") ?? "populated"
const timerState = params.get("timer") ?? "idle"
const holdTimer = params.get("holdTimer") === "true"
const messages = []
let offline = state === "offline"
let stale = state === "stale"
let editOffline = state === "edit-offline"
let editError = state === "edit-error"
let timerOffline = timerState === "offline"
let timerStale = timerState === "stale"
const initialItems =
  state === "empty" || state === "loading" || state === "offline"
    ? []
    : [
        {
          id: "todo-open",
          title: "Review the launch checklist",
          detail: "Confirm owners, rollout order, and rollback signals.",
          dueAt: new Date("2030-04-05T14:30:00").getTime(),
          reminderAt: state === "epoch" ? 0 : new Date("2030-04-05T13:30:00").getTime(),
          done: false,
          revision: 1,
          createdAt: 10,
          updatedAt: 30,
        },
        { id: "todo-done", title: "Confirm the release owner", done: true, revision: 1, createdAt: 5, updatedAt: 20 },
      ]
let items = JSON.parse(localStorage.getItem("raya-todo-fixture-items") ?? "null") ?? initialItems
const saveItems = (next) => {
  items = next
  localStorage.setItem("raya-todo-fixture-items", JSON.stringify(next))
}
const clock = Date.now()
const initialTimer = {
  version: 1,
  state: ["idle", "running", "paused", "completed"].includes(timerState) ? timerState : "running",
  durationMs: 1_500_000,
  todoID: "todo-open",
  todoExists: true,
  elapsedMs: timerState === "completed" ? 1_500_000 : 300_000,
  remainingMs: timerState === "completed" ? 0 : 1_200_000,
  startedAt: clock - 300_000,
  runStartedAt: timerState === "running" || timerState === "stale" || timerState === "offline" ? clock : undefined,
  completedAt: timerState === "completed" ? clock : undefined,
  updatedAt: clock,
  revision: 2,
}
let timer = JSON.parse(localStorage.getItem("raya-todo-fixture-timer") ?? "null") ?? initialTimer
const saveTimer = (next) => {
  timer = next
  localStorage.setItem("raya-todo-fixture-timer", JSON.stringify(next))
}

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
    if (message.type === "focusTimerGet") {
      if (timerState === "loading") return
      if (timerOffline) {
        timerOffline = false
        emit({
          type: "focusTimerResult",
          requestID: message.requestID,
          operation: "get",
          error: { kind: "offline", message: "Raya is offline. The saved focus timer is unchanged." },
        })
        return
      }
      emit({ type: "focusTimerResult", requestID: message.requestID, operation: "get", timer })
      return
    }
    if (message.type.startsWith("focusTimer") && message.type !== "focusTimerGet") {
      if (holdTimer) return
      const operation = message.type.replace("focusTimer", "").toLowerCase()
      if (timerStale) {
        timerStale = false
        const latest = { ...timer, revision: timer.revision + 1 }
        saveTimer(latest)
        emit({
          type: "focusTimerResult",
          requestID: message.requestID,
          operation,
          error: {
            kind: "stale",
            message: "The focus timer changed before this action.",
            expected: message.revision,
            actual: latest.revision,
            latest,
          },
        })
        return
      }
      const next =
        operation === "start"
          ? {
              ...timer,
              state: "running",
              durationMs: message.durationMs,
              todoID: message.todoID,
              todoExists: message.todoID ? true : undefined,
              elapsedMs: 0,
              remainingMs: message.durationMs,
              startedAt: Date.now(),
              runStartedAt: Date.now(),
              completedAt: undefined,
              updatedAt: Date.now(),
              revision: timer.revision + 1,
            }
          : operation === "pause"
            ? { ...timer, state: "paused", runStartedAt: undefined, revision: timer.revision + 1 }
            : operation === "resume"
              ? { ...timer, state: "running", runStartedAt: Date.now(), revision: timer.revision + 1 }
              : { ...timer, state: "idle", elapsedMs: 0, remainingMs: timer.durationMs, revision: timer.revision + 1 }
      saveTimer(next)
      emit({ type: "focusTimerResult", requestID: message.requestID, operation, timer: next })
      return
    }
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
        reminderAt: message.reminderAt,
        done: false,
        revision: 1,
        createdAt: 40 + items.length,
        updatedAt: 40 + items.length,
      }
      saveItems([...items, item])
      emit({ type: "personalTodoResult", requestID: message.requestID, operation: "create", item })
      return
    }
    if (message.type === "personalTodoUpdate") {
      const current = items.find((item) => item.id === message.todoID)
      if (!current) return
      if (editOffline) {
        editOffline = false
        emit({
          type: "personalTodoResult",
          requestID: message.requestID,
          operation: "update",
          error: { kind: "offline", message: "Raya is offline. Your edit is still here." },
        })
        return
      }
      if (editError) {
        editError = false
        emit({
          type: "personalTodoResult",
          requestID: message.requestID,
          operation: "update",
          error: { kind: "error", message: "Raya could not save this edit." },
        })
        return
      }
      if (stale) {
        stale = false
        const latest = { ...current, revision: 2, updatedAt: 50 }
        saveItems(items.map((item) => (item.id === latest.id ? latest : item)))
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
      const item = {
        ...current,
        ...(message.title === undefined ? {} : { title: message.title }),
        ...(message.detail === undefined ? {} : { detail: message.detail ?? undefined }),
        ...(message.done === undefined ? {} : { done: message.done }),
        ...(message.dueAt === undefined ? {} : { dueAt: message.dueAt ?? undefined }),
        ...(message.reminderAt === undefined ? {} : { reminderAt: message.reminderAt ?? undefined }),
        revision: current.revision + 1,
        updatedAt: 60,
      }
      saveItems(items.map((row) => (row.id === item.id ? item : row)))
      emit({ type: "personalTodoResult", requestID: message.requestID, operation: "update", item })
      return
    }
    if (message.type === "personalTodoDelete") {
      saveItems(items.filter((item) => item.id !== message.todoID))
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
