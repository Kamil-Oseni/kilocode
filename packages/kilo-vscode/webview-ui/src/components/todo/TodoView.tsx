import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage, PersonalTodoItem } from "../../types/messages"

type Intent =
  | { operation: "create"; title: string }
  | { operation: "update"; todoID: string; done: boolean }
  | { operation: "delete"; todoID: string }

type Notice = { kind: "offline" | "stale" | "error"; message: string }

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
  const requests = new Map<string, Intent | { operation: "list" }>()

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

  const receive = (message: ExtensionMessage) => {
    if (message.type !== "personalTodoResult") return
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

  const unsubscribe = vscode.onMessage(receive)
  onCleanup(unsubscribe)
  onMount(() => send({ operation: "list" }))

  const remaining = createMemo(() => items().filter((item) => !item.done).length)
  const retry = () => {
    const intent = recovery()
    if (!intent) return send({ operation: "list" })
    setRecovery()
    setNotice()
    send(intent)
  }

  return (
    <main data-component="personal-todo" aria-labelledby="personal-todo-title">
      <header data-slot="personal-todo-header">
        <IconButton icon="arrow-left" variant="ghost" size="small" aria-label="Back to chat" onClick={props.onBack} />
        <div>
          <h1 id="personal-todo-title">Todo</h1>
          <p>{remaining()} open</p>
        </div>
      </header>

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
