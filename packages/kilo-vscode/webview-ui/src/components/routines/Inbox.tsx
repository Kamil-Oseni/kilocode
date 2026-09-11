import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"

export type Note = {
  id: string
  agentID: string
  kind: "user" | "worker" | "report" | "decision" | "delegation"
  source: string
  body: string
  occurrenceID?: string
  sessionID?: string
  time: number
}

export type Box = {
  agentID: string
  conversationID: string
  name: string
  role: string
  latest?: Note
  unread: number
  state: "scheduled" | "running" | "waiting" | "needs_input" | "paused" | "failed"
  nextRun?: number
  draft?: string
}

function stamp(at: number) {
  return new Date(at).toLocaleString()
}

function kind(value: Note["kind"]) {
  if (value === "report") return "Report"
  if (value === "decision") return "Needs a decision"
  if (value === "delegation") return "Delegation"
  if (value === "worker") return "Worker"
  return "You"
}

export function status(state: Box["state"]) {
  if (state === "needs_input") return "Needs input"
  if (state === "waiting") return "Waiting"
  if (state === "paused") return "Paused"
  if (state === "failed") return "Failed"
  if (state === "running") return "Running"
  return "Scheduled"
}

export const Inbox: Component<{
  agentID: string
  name: string
  role: string
  box?: Box
  workspace?: string
  onBack?: () => void
}> = (props) => {
  const vscode = useVSCode()
  const [thread, setThread] = createSignal<Note[]>([])
  const [cursor, setNext] = createSignal<string>()
  const [note, setNote] = createSignal("")
  const [phase, setPhase] = createSignal<"idle" | "sending" | "failed">("idle")
  const [error, setError] = createSignal("")
  let source = `user:${crypto.randomUUID()}`
  let pageID = ""
  let sendID = ""
  let older = false
  let wait = false
  let stick = true
  let seen = ""
  let pane: HTMLDivElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const load = (after?: string) => {
    if (wait && !after) return
    wait = true
    older = !!after
    pageID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineInboxPage",
      requestID: pageID,
      agentID: props.agentID,
      ...(after ? { cursor: after } : {}),
    })
  }

  const pin = () => {
    if (!stick || !pane) return
    pane.scrollTop = pane.scrollHeight
  }

  createEffect(() => {
    const id = props.agentID
    const latest = props.box?.latest?.id
    if (id !== seen) {
      seen = id
      wait = false
      source = `user:${crypto.randomUUID()}`
      setThread([])
      setNext()
      setPhase("idle")
      setError("")
      setNote(props.box?.draft ?? "")
      stick = true
      load()
      return
    }
    if (latest && !thread().some((item) => item.id === latest)) load()
  })

  const receive = (msg: ExtensionMessage) => {
    if (msg.type === "routineInboxPage" && msg.requestID === pageID && msg.agentID === props.agentID) {
      wait = false
      if (msg.error) {
        setError(msg.error)
        return
      }
      const rows = Array.isArray(msg.messages) ? (msg.messages as Note[]) : []
      setThread((prior) => (older ? [...rows, ...prior] : rows))
      setNext(msg.next)
      setError("")
      const last = rows.at(-1)
      if (last && !older)
        vscode.postMessage({
          type: "routineInboxRead",
          requestID: crypto.randomUUID(),
          agentID: props.agentID,
          at: last.time,
        })
      queueMicrotask(pin)
    }
    if (msg.type === "routineInboxSent" && msg.requestID === sendID && msg.agentID === props.agentID) {
      if (msg.error) {
        setPhase("failed")
        setError(msg.error)
        return
      }
      const saved = msg.message as Note | undefined
      if (saved?.id) setThread((prior) => (prior.some((item) => item.id === saved.id) ? prior : [...prior, saved]))
      source = `user:${crypto.randomUUID()}`
      setNote("")
      setPhase("idle")
      setError("")
      vscode.postMessage({
        type: "routineInboxDraft",
        requestID: crypto.randomUUID(),
        agentID: props.agentID,
        draft: null,
      })
      stick = true
      queueMicrotask(pin)
    }
  }

  const unsub = vscode.onMessage(receive)
  onCleanup(() => {
    unsub()
    if (timer) clearTimeout(timer)
  })

  const change = (value: string) => {
    setNote(value)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      vscode.postMessage({
        type: "routineInboxDraft",
        requestID: crypto.randomUUID(),
        agentID: props.agentID,
        draft: value.trim() ? value : null,
      })
    }, 400)
  }

  const submit = () => {
    const body = note().trim()
    if (!body || phase() === "sending") return
    setPhase("sending")
    setError("")
    sendID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineInboxSend",
      requestID: sendID,
      agentID: props.agentID,
      source,
      body,
    })
  }

  return (
    <div class="routines-thread">
      <header class="routines-thread-head">
        <Show when={props.onBack}>
          <Button variant="ghost" size="small" onClick={props.onBack}>
            Back
          </Button>
        </Show>
        <div class="routines-thread-identity">
          <strong>{props.name}</strong>
          <span class="routines-meta">
            {props.role}
            <Show when={props.workspace}> · {props.workspace}</Show>
            {` · ${status(props.box?.state ?? "scheduled")}`}
            <Show when={props.box?.nextRun}>{(at) => <> · Next {stamp(at())}</>}</Show>
          </span>
        </div>
      </header>
      <div
        ref={pane}
        class="routines-thread-body"
        onScroll={() => {
          if (!pane) return
          stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48
        }}
      >
        <Show when={cursor()}>
          <Button
            variant="ghost"
            size="small"
            onClick={() => {
              const after = cursor()
              if (after) load(after)
            }}
          >
            Earlier messages
          </Button>
        </Show>
        <Show when={!thread().length}>
          <p class="routines-empty">Reports and follow-ups for this worker will appear here.</p>
        </Show>
        <For each={thread()}>
          {(item) => (
            <article class="routines-line" data-kind={item.kind} data-source={item.source}>
              <span class="routines-line-meta">
                {kind(item.kind)} · {stamp(item.time)}
              </span>
              <p class="routines-line-body">{item.body}</p>
            </article>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="routines-error" role="alert">
          {error()}
        </p>
      </Show>
      <form
        class="routines-composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label class="routines-field">
          Message this worker
          <textarea
            value={note()}
            rows={3}
            aria-label="Message this worker"
            placeholder="Ask about a report in this conversation."
            onInput={(event) => change(event.currentTarget.value)}
          />
        </label>
        <p class="routines-hint">Asks this worker about reports here. Does not change the assignment.</p>
        <Button type="button" size="small" disabled={phase() === "sending" || !note().trim()} onClick={submit}>
          {phase() === "sending" ? "Asking this worker" : phase() === "failed" ? "Retry follow-up" : "Send"}
        </Button>
      </form>
    </div>
  )
}
