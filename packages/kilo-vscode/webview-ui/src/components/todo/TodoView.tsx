import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Select } from "@kilocode/kilo-ui/select"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage, FocusTimerItem, PersonalTodoItem } from "../../types/messages"

type Intent =
  | { operation: "create"; title: string }
  | { operation: "update"; todoID: string; done: boolean }
  | { operation: "delete"; todoID: string }

type Notice = { kind: "offline" | "stale" | "error"; message: string }
type TimerIntent =
  | { operation: "start"; durationMs: number; todoID?: string }
  | { operation: "pause" | "resume" | "reset" }

const durations = [
  { label: "15 minutes", value: 15 * 60_000 },
  { label: "25 minutes", value: 25 * 60_000 },
  { label: "45 minutes", value: 45 * 60_000 },
  { label: "1 hour", value: 60 * 60_000 },
]

const order = (items: PersonalTodoItem[]) =>
  [...items].sort((a, b) => Number(a.done) - Number(b.done) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

export const TodoView: Component<{ onBack: () => void }> = (props) => {
  const vscode = useVSCode()
  const [items, setItems] = createSignal<PersonalTodoItem[]>([])
  const [draft, setDraft] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [notice, setNotice] = createSignal<Notice>()
  const [confirming, setConfirming] = createSignal<string>()
  const [recovery, setRecovery] = createSignal<Intent>()
  const [pending, setPending] = createSignal<Record<string, true>>({})
  const [timer, setTimer] = createSignal<FocusTimerItem>()
  const [timerLoading, setTimerLoading] = createSignal(true)
  const [timerPending, setTimerPending] = createSignal(false)
  const [timerNotice, setTimerNotice] = createSignal<Notice>()
  const [timerRecovery, setTimerRecovery] = createSignal<TimerIntent>()
  const [duration, setDuration] = createSignal(durations[1])
  const [todo, setTodo] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const [checkpoint, setCheckpoint] = createSignal<number>()
  const requests = new Map<string, Intent | { operation: "list" }>()
  const timers = new Map<string, TimerIntent | { operation: "get" }>()

  const send = (intent: Intent | { operation: "list" }) => {
    const item = "todoID" in intent ? items().find((row) => row.id === intent.todoID) : undefined
    if ("todoID" in intent && !item) {
      setNotice({ kind: "error", message: "That todo is no longer available. Refresh to see the latest list." })
      setRecovery()
      return
    }
    const requestID = crypto.randomUUID()
    requests.set(requestID, intent)
    if (intent.operation !== "list")
      setPending((state) => ({ ...state, ["todoID" in intent ? intent.todoID : "create"]: true }))
    if (intent.operation === "list") vscode.postMessage({ type: "personalTodoList", requestID })
    if (intent.operation === "create")
      vscode.postMessage({ type: "personalTodoCreate", requestID, title: intent.title })
    if (intent.operation === "update" && item)
      vscode.postMessage({
        type: "personalTodoUpdate",
        requestID,
        todoID: item.id,
        revision: item.revision,
        done: intent.done,
      })
    if (intent.operation === "delete" && item)
      vscode.postMessage({ type: "personalTodoDelete", requestID, todoID: item.id, revision: item.revision })
  }

  const settle = (intent: Intent | { operation: "list" }) => {
    if (intent.operation === "list") return
    const key = "todoID" in intent ? intent.todoID : "create"
    setPending((state) => {
      const next = { ...state }
      delete next[key]
      return next
    })
  }

  const replace = (item: PersonalTodoItem) =>
    setItems((rows) =>
      order(
        rows.some((row) => row.id === item.id) ? rows.map((row) => (row.id === item.id ? item : row)) : [...rows, item],
      ),
    )

  const receiveTimer = (message: Extract<ExtensionMessage, { type: "focusTimerResult" }>) => {
    const intent = timers.get(message.requestID)
    if (!intent) return
    timers.delete(message.requestID)
    setTimerLoading(false)
    setTimerPending(false)
    if (message.error) {
      if (message.error.latest) setTimer(message.error.latest)
      const detail =
        message.error.kind === "stale" && message.error.expected !== undefined && message.error.actual !== undefined
          ? `${message.error.message} Saved version ${message.error.actual} replaced version ${message.error.expected}.`
          : message.error.message
      setTimerNotice({ kind: message.error.kind, message: detail })
      setTimerRecovery(intent.operation === "get" ? undefined : intent)
      return
    }
    if (message.timer) {
      setTimer(message.timer)
      setNow(Date.now())
      const option = durations.find((item) => item.value === message.timer?.durationMs)
      if (option) setDuration(option)
      setTodo(message.timer.todoID)
    }
    setTimerNotice()
    setTimerRecovery()
  }

  const receiveTodo = (message: Extract<ExtensionMessage, { type: "personalTodoResult" }>) => {
    const intent = requests.get(message.requestID)
    if (!intent) return
    requests.delete(message.requestID)
    settle(intent)
    if (message.operation === "list") setLoading(false)
    if (message.error) {
      if (message.error.latest) replace(message.error.latest)
      const detail =
        message.error.kind === "stale" && message.error.expected !== undefined && message.error.actual !== undefined
          ? `${message.error.message} Saved version ${message.error.actual} replaced version ${message.error.expected}.`
          : message.error.message
      setNotice({ kind: message.error.kind, message: detail })
      setRecovery(intent.operation === "list" ? undefined : intent)
      return
    }
    setNotice()
    setRecovery()
    if (message.items) setItems(order(message.items))
    if (message.item) replace(message.item)
    if (message.removed && message.todoID) setItems((rows) => rows.filter((row) => row.id !== message.todoID))
    if (intent.operation === "create") setDraft("")
    if (intent.operation === "delete") setConfirming()
  }

  const receive = (message: ExtensionMessage) => {
    if (message.type === "focusTimerResult") return receiveTimer(message)
    if (message.type === "personalTodoResult") receiveTodo(message)
  }

  const unsubscribe = vscode.onMessage(receive)
  onCleanup(unsubscribe)
  onMount(() => {
    send({ operation: "list" })
    sendTimer({ operation: "get" })
  })

  createEffect(() => {
    if (timer()?.state !== "running") return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => window.clearInterval(id))
  })

  const remaining = createMemo(() => items().filter((item) => !item.done).length)
  const retry = () => {
    const intent = recovery()
    if (!intent) return send({ operation: "list" })
    setRecovery()
    setNotice()
    send(intent)
  }
  const sendTimer = (intent: TimerIntent | { operation: "get" }) => {
    const requestID = crypto.randomUUID()
    timers.set(requestID, intent)
    if (intent.operation !== "get") setTimerPending(true)
    if (intent.operation === "get") vscode.postMessage({ type: "focusTimerGet", requestID })
    const saved = timer()
    if (intent.operation === "start" && saved)
      vscode.postMessage({
        type: "focusTimerStart",
        requestID,
        revision: saved.revision,
        durationMs: intent.durationMs,
        todoID: intent.todoID,
      })
    if (intent.operation === "pause" && saved)
      vscode.postMessage({ type: "focusTimerPause", requestID, revision: saved.revision })
    if (intent.operation === "resume" && saved)
      vscode.postMessage({ type: "focusTimerResume", requestID, revision: saved.revision })
    if (intent.operation === "reset" && saved)
      vscode.postMessage({ type: "focusTimerReset", requestID, revision: saved.revision })
  }
  const timerRetry = () => {
    const intent = timerRecovery()
    setTimerRecovery()
    setTimerNotice()
    sendTimer(intent ?? { operation: "get" })
  }
  const remainingMs = createMemo(() => {
    const saved = timer()
    if (!saved) return 0
    if (saved.state !== "running") return saved.remainingMs
    return Math.max(0, saved.remainingMs - Math.max(0, now() - saved.updatedAt))
  })
  createEffect(() => {
    const saved = timer()
    if (!saved || saved.state !== "running" || remainingMs() > 0 || checkpoint() === saved.revision) return
    setCheckpoint(saved.revision)
    sendTimer({ operation: "get" })
  })
  const clock = createMemo(() => {
    const seconds = Math.ceil(remainingMs() / 1_000)
    return `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
  })
  const timerLabel = createMemo(() => {
    const state = timer()?.state
    if (state === "running") return "Focusing"
    if (state === "paused") return "Paused"
    if (state === "completed") return "Focus complete"
    return "Ready when you are"
  })
  const todoOptions = createMemo(() => [
    { id: "", label: "No linked todo" },
    ...items()
      .filter((item) => !item.done)
      .map((item) => ({ id: item.id, label: item.title })),
  ])
  const todoOption = createMemo(() => todoOptions().find((item) => item.id === (todo() ?? "")) ?? todoOptions()[0])
  const panel = () => (
    <section data-slot="focus-timer" data-state={timer()?.state ?? "loading"} aria-labelledby="focus-timer-title">
      <div data-slot="focus-timer-copy">
        <div>
          <h2 id="focus-timer-title">Focus timer</h2>
          <p>{timerLoading() ? "Checking your saved timer…" : timerLabel()}</p>
        </div>
        <output aria-label="Focus time remaining" aria-live="off">
          {timerLoading() ? "--:--" : clock()}
        </output>
      </div>
      <Show when={timer()?.todoID}>
        <p data-slot="focus-timer-link">
          {timer()?.todoExists === false ? "Linked todo is no longer available" : `Linked to ${todoOption().label}`}
        </p>
      </Show>
      <Show when={timerNotice()}>
        {(current) => (
          <div data-slot="focus-timer-notice" data-kind={current().kind} role="alert">
            <span>{current().message}</span>
            <Button variant="ghost" size="small" onClick={timerRetry}>
              {current().kind === "stale" ? "Review and retry" : "Try again"}
            </Button>
          </div>
        )}
      </Show>
      <Show when={!timerLoading() && (timer()?.state === "idle" || timer()?.state === "completed")}>
        <div data-slot="focus-timer-fields">
          <label>
            <span>Duration</span>
            <Select
              options={durations}
              current={duration()}
              value={(item) => String(item.value)}
              label={(item) => item.label}
              onSelect={(item) => {
                if (item) setDuration(item)
              }}
              aria-label="Focus duration"
              disabled={timerPending()}
            />
          </label>
          <label>
            <span>Work on</span>
            <Select
              options={todoOptions()}
              current={todoOption()}
              value={(item) => item.id}
              label={(item) => item.label}
              onSelect={(item) => setTodo(item?.id || undefined)}
              aria-label="Linked todo"
              disabled={timerPending()}
            />
          </label>
        </div>
      </Show>
      <div data-slot="focus-timer-actions">
        <Show when={timer()?.state === "idle" || timer()?.state === "completed"}>
          <Button
            size="small"
            disabled={timerLoading() || timerPending() || !timer()}
            onClick={() => sendTimer({ operation: "start", durationMs: duration().value, todoID: todo() })}
          >
            Start focus
          </Button>
        </Show>
        <Show when={timer()?.state === "running"}>
          <Button size="small" disabled={timerPending()} onClick={() => sendTimer({ operation: "pause" })}>
            Pause
          </Button>
        </Show>
        <Show when={timer()?.state === "paused"}>
          <Button size="small" disabled={timerPending()} onClick={() => sendTimer({ operation: "resume" })}>
            Resume
          </Button>
        </Show>
        <Show when={timer()?.state !== "idle"}>
          <Button
            variant="ghost"
            size="small"
            disabled={timerPending()}
            onClick={() => sendTimer({ operation: "reset" })}
          >
            Reset
          </Button>
        </Show>
      </div>
    </section>
  )

  return (
    <main data-component="personal-todo" aria-labelledby="personal-todo-title">
      <header data-slot="personal-todo-header">
        <IconButton icon="arrow-left" variant="ghost" size="small" aria-label="Back to chat" onClick={props.onBack} />
        <div>
          <h1 id="personal-todo-title">Todo</h1>
          <p>{remaining()} open</p>
        </div>
      </header>

      {panel()}

      <form
        data-slot="personal-todo-compose"
        onSubmit={(event) => {
          event.preventDefault()
          const title = draft().trim()
          if (title) send({ operation: "create", title })
        }}
      >
        <TextField
          value={draft()}
          onChange={setDraft}
          aria-label="New todo"
          placeholder="What needs your attention?"
          maxLength={500}
          disabled={pending().create === true}
        />
        <Button type="submit" size="small" disabled={!draft().trim() || pending().create === true}>
          Add
        </Button>
      </form>

      <Show when={notice()}>
        {(current) => (
          <section data-slot="personal-todo-notice" data-kind={current().kind} role="alert">
            <span>{current().message}</span>
            <Button variant="ghost" size="small" onClick={retry}>
              {current().kind === "stale" ? "Review and retry" : "Try again"}
            </Button>
          </section>
        )}
      </Show>

      <Show when={loading()}>
        <div data-slot="personal-todo-loading" role="status">
          <Spinner /> <span>Loading your todos…</span>
        </div>
      </Show>

      <Show when={!loading() && items().length === 0 && !notice()}>
        <section data-slot="personal-todo-empty">
          <span aria-hidden="true">✓</span>
          <h2>Nothing waiting</h2>
          <p>Add one clear next step above.</p>
        </section>
      </Show>

      <Show when={!loading() && items().length > 0}>
        <ul data-slot="personal-todo-list" aria-label="Personal todos">
          <For each={items()}>
            {(item) => (
              <li data-slot="personal-todo-item" data-done={item.done}>
                <Checkbox
                  hideLabel
                  checked={item.done}
                  disabled={pending()[item.id] === true}
                  onChange={(done) => send({ operation: "update", todoID: item.id, done })}
                >
                  {item.done ? `Reopen ${item.title}` : `Complete ${item.title}`}
                </Checkbox>
                <span>{item.title}</span>
                <Show
                  when={confirming() === item.id}
                  fallback={
                    <IconButton
                      icon="trash"
                      variant="ghost"
                      size="small"
                      aria-label={`Delete ${item.title}`}
                      disabled={pending()[item.id] === true}
                      onClick={() => setConfirming(item.id)}
                    />
                  }
                >
                  <div data-slot="personal-todo-confirm" role="group" aria-label={`Confirm deleting ${item.title}`}>
                    <Button variant="ghost" size="small" onClick={() => setConfirming()}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="small"
                      disabled={pending()[item.id] === true}
                      onClick={() => send({ operation: "delete", todoID: item.id })}
                    >
                      Delete
                    </Button>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </main>
  )
}
