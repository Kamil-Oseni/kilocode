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
  files?: { name: string; path: string }[]
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

type Peer = {
  id: string
  name: string
  role: string
  enabled?: boolean
}

function ready(item: Peer) {
  return item.enabled !== false
}

function stamp(at: number) {
  return new Date(at).toLocaleString()
}

function kind(value: Note["kind"], source?: string) {
  if (value === "report") return "Report"
  if (value === "decision") return "Needs a decision"
  if (value === "delegation") {
    if (source?.startsWith("sent:")) return "Asked another worker"
    if (source?.startsWith("reply:")) return "Answer from another worker"
    if (source?.startsWith("start:")) return "Work started"
    return "Asked you"
  }
  if (value === "worker") return "Worker"
  return "You"
}

function pending(item: Note, rows: Note[]) {
  if (item.kind !== "delegation" || !item.occurrenceID) return false
  if (!item.source.startsWith("sent:") && !item.source.startsWith("ask:")) return false
  const at = item.source.indexOf(":")
  const key = at <= 0 ? "" : item.source.slice(at + 1)
  return !rows.some((row) => row.source === `reply:${key}`)
}

function linked(item: Note) {
  if (item.kind !== "delegation" || !item.occurrenceID) return
  if (!item.source.startsWith("sent:") && !item.source.startsWith("ask:")) return
  return item.occurrenceID
}

type Step = { id: string; state: string; objective: string }

type Tree = {
  record: Step
  above: Step[]
  below: Step[]
}

function step(value: unknown): Step | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  if (typeof row.id !== "string" || typeof row.state !== "string" || typeof row.objective !== "string") return
  return { id: row.id, state: row.state, objective: row.objective }
}

function listed(value: unknown): Step[] {
  if (!Array.isArray(value)) return []
  const rows: Step[] = []
  for (const item of value) {
    const row = step(item)
    if (row) rows.push(row)
  }
  return rows
}

function tree(value: { record?: unknown; above?: unknown; below?: unknown }) {
  const record = step(value.record)
  if (!record) return
  return { record, above: listed(value.above), below: listed(value.below) }
}

function title(role: "prior" | "this" | "follow") {
  if (role === "prior") return "Prior request"
  if (role === "follow") return "Follow-on request"
  return "This request"
}

const Trace: Component<{
  id: string
  busy: boolean
  tree?: Tree
  error?: string
  onShow: (id: string) => void
}> = (props) => {
  const rows = () => {
    const found = props.tree
    if (!found) return []
    return [
      ...found.above.map((item) => ({ ...item, role: "prior" as const })),
      { ...found.record, role: "this" as const },
      ...found.below.map((item) => ({ ...item, role: "follow" as const })),
    ]
  }
  return (
    <>
      <Button
        type="button"
        size="small"
        variant="ghost"
        disabled={props.busy}
        onClick={() => props.onShow(props.id)}
      >
        {props.busy ? "Loading request chain" : props.tree ? "Refresh request chain" : "Show request chain"}
      </Button>
      <Show when={props.error}>
        <p class="routines-error" role="alert">
          {props.error}
        </p>
      </Show>
      <Show when={props.tree}>
        <ol class="routines-chain" aria-label="Request chain">
          <For each={rows()}>
            {(item) => (
              <li data-role={item.role}>
                <span class="routines-line-meta">
                  {title(item.role)} · {item.state}
                </span>
                <p class="routines-line-body">{item.objective}</p>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </>
  )
}

const Line: Component<{
  item: Note
  rows: Note[]
  busy: boolean
  look: string
  tree?: Tree
  fault?: string
  onStop: (id: string) => void
  onShow: (id: string) => void
}> = (props) => {
  const live = () => pending(props.item, props.rows)
  const id = () => linked(props.item)
  return (
    <article class="routines-line" data-kind={props.item.kind} data-source={props.item.source}>
      <span class="routines-line-meta">
        {kind(props.item.kind, props.item.source)} · {stamp(props.item.time)}
      </span>
      <p class="routines-line-body">{props.item.body}</p>
      <Files items={props.item.files} session={props.item.sessionID} />
      <Show when={live()}>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={props.busy}
          onClick={() => {
            const id = props.item.occurrenceID
            if (id) props.onStop(id)
          }}
        >
          {props.busy ? "Stopping" : "Stop this request"}
        </Button>
      </Show>
      <Show when={id()}>
        {(value) => (
          <Trace
            id={value()}
            busy={props.look === value()}
            tree={props.tree}
            error={props.fault}
            onShow={props.onShow}
          />
        )}
      </Show>
    </article>
  )
}

function clips(value: unknown) {
  if (!Array.isArray(value)) return []
  const rows: NonNullable<Note["files"]> = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const name = (item as { name?: unknown }).name
    const path = (item as { path?: unknown }).path
    if (typeof name !== "string" || typeof path !== "string") continue
    if (!name.trim() || !path.trim()) continue
    rows.push({ name, path })
  }
  return rows
}

export const Files: Component<{ items?: Note["files"]; session?: string }> = (props) => {
  const vscode = useVSCode()
  const rows = () => clips(props.items)
  return (
    <Show when={rows().length}>
      <ul class="routines-files" aria-label="Attached files">
        <For each={rows()}>
          {(file) => (
            <li>
              <button
                type="button"
                class="routines-file"
                aria-label={`Open ${file.name}`}
                onClick={() =>
                  vscode.postMessage({
                    type: "openFile",
                    filePath: file.path,
                    ...(props.session ? { sessionID: props.session } : {}),
                  })
                }
              >
                <span class="routines-file-name">{file.name}</span>
                <span class="routines-file-path">{file.path}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

export function status(state: Box["state"]) {
  if (state === "needs_input") return "Needs input"
  if (state === "waiting") return "Waiting"
  if (state === "paused") return "Paused"
  if (state === "failed") return "Failed"
  if (state === "running") return "Running"
  return "Scheduled"
}

function saved(value: unknown) {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  const state = typeof row.state === "string" ? row.state : undefined
  const reason = typeof row.reason === "string" ? row.reason : undefined
  if (!state) return
  return { state, reason }
}

const Pass: Component<{ agentID: string; workers: Peer[]; runID?: string; onDone?: () => void }> = (props) => {
  const vscode = useVSCode()
  const [ask, setAsk] = createSignal("")
  const [phase, setPhase] = createSignal<"idle" | "sending" | "failed">("idle")
  const [error, setError] = createSignal("")
  const [news, setNews] = createSignal("")
  let source = `dlg:${crypto.randomUUID()}`
  let sendID = ""
  let seen = ""

  const reset = (id: string) => {
    seen = id
    source = `dlg:${crypto.randomUUID()}`
    setAsk("")
    setPhase("idle")
    setError("")
    setNews("")
  }

  createEffect(() => {
    const id = props.agentID
    if (id !== seen) reset(id)
  })

  const receive = (msg: ExtensionMessage) => {
    if (msg.type !== "routineDelegated" || msg.requestID !== sendID || msg.agentID !== props.agentID) return
    if (msg.error) {
      setPhase("failed")
      setError(msg.error)
      setNews("")
      return
    }
    const row = saved(msg.record)
    if (row?.state === "failed") {
      setPhase("failed")
      setError(row.reason || "This worker did not start the request.")
      setNews("")
      return
    }
    source = `dlg:${crypto.randomUUID()}`
    setAsk("")
    setPhase("idle")
    setError("")
    setNews(
      row?.state === "queued"
        ? "Queued until this worker is free. It has not started."
        : row?.state === "running" || row?.state === "accepted"
          ? "This worker started the request."
          : "",
    )
    props.onDone?.()
  }

  const unsub = vscode.onMessage(receive)
  onCleanup(unsub)

  const submit = (recipientID: string) => {
    const body = ask().trim()
    const peer = props.workers.find((item) => item.id === recipientID)
    if (!body || phase() === "sending" || (peer && !ready(peer))) return
    setPhase("sending")
    setError("")
    setNews("")
    sendID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineDelegate",
      requestID: sendID,
      agentID: props.agentID,
      recipientID,
      source,
      objective: body,
      ...(props.runID ? { parentRunID: props.runID } : {}),
    })
  }

  return (
    <form
      class="routines-composer routines-delegate"
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <label class="routines-field">
        Ask another worker
        <textarea
          value={ask()}
          rows={3}
          aria-label="Ask another worker"
          placeholder="What should they answer?"
          onInput={(event) => setAsk(event.currentTarget.value)}
        />
      </label>
      <p class="routines-hint">Asks another worker for a tracked result. Does not change either assignment.</p>
      <Show when={props.workers.some((item) => !ready(item))}>
        <p class="routines-hint">Paused workers cannot start a new request until they are enabled.</p>
      </Show>
      <Show when={news()}>
        <p class="routines-hint" role="status">
          {news()}
        </p>
      </Show>
      <Show when={error()}>
        <p class="routines-error" role="alert">
          {error()}
        </p>
      </Show>
      <For each={props.workers}>
        {(item) => (
          <Button
            type="button"
            size="small"
            disabled={phase() === "sending" || !ask().trim() || !ready(item)}
            onClick={() => submit(item.id)}
          >
            {phase() === "sending"
              ? "Asking"
              : !ready(item)
                ? `${item.name} is paused`
                : phase() === "failed"
                  ? `Retry ask ${item.name}`
                  : `Ask ${item.name}`}
          </Button>
        )}
      </For>
    </form>
  )
}

export const Inbox: Component<{
  agentID: string
  name: string
  role: string
  box?: Box
  workspace?: string
  workers?: Peer[]
  runID?: string
  onBack?: () => void
}> = (props) => {
  const vscode = useVSCode()
  const [thread, setThread] = createSignal<Note[]>([])
  const [cursor, setNext] = createSignal<string>()
  const [note, setNote] = createSignal("")
  const [phase, setPhase] = createSignal<"idle" | "sending" | "failed">("idle")
  const [error, setError] = createSignal("")
  const [halt, setHalt] = createSignal<"idle" | "sending" | "failed">("idle")
  const [look, setLook] = createSignal("")
  const [trees, setTrees] = createSignal<Record<string, Tree>>({})
  const [faults, setFaults] = createSignal<Record<string, string>>({})
  let source = `user:${crypto.randomUUID()}`
  let pageID = ""
  let sendID = ""
  let haltID = ""
  let lookID = ""
  let older = false
  let wait = false
  let stick = true
  let seen = ""
  let pane: HTMLDivElement | undefined
  let frame: HTMLDivElement | undefined
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
      setHalt("idle")
      setLook("")
      setTrees({})
      setFaults({})
      setError("")
      setNote(props.box?.draft ?? "")
      stick = true
      load()
      queueMicrotask(() => frame?.focus())
      return
    }
    if (latest && !thread().some((item) => item.id === latest)) load()
  })

  const page = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxPage" || msg.requestID !== pageID || msg.agentID !== props.agentID) return
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

  const sent = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxSent" || msg.requestID !== sendID || msg.agentID !== props.agentID) return
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

  const halted = (msg: ExtensionMessage) => {
    if (msg.type !== "routineDelegateStopped" || msg.requestID !== haltID || msg.agentID !== props.agentID) return
    if (msg.error) {
      setHalt("failed")
      setError(msg.error)
      return
    }
    setHalt("idle")
    setError("")
    wait = false
    load()
  }

  const chained = (msg: ExtensionMessage) => {
    if (msg.type !== "routineDelegateChain" || msg.requestID !== lookID || msg.agentID !== props.agentID) return
    const id = typeof msg.id === "string" ? msg.id : look()
    if (msg.error) {
      if (id) setFaults((prior) => ({ ...prior, [id]: msg.error || "The request chain could not be read." }))
      setLook("")
      return
    }
    const next = tree({ record: msg.record, above: msg.above, below: msg.below })
    if (!id || !next) {
      if (id) setFaults((prior) => ({ ...prior, [id]: "The request chain could not be read." }))
      setLook("")
      return
    }
    setFaults((prior) => {
      const copy = { ...prior }
      delete copy[id]
      return copy
    })
    setTrees((prior) => ({ ...prior, [id]: next }))
    setLook("")
  }

  const receive = (msg: ExtensionMessage) => {
    page(msg)
    sent(msg)
    halted(msg)
    chained(msg)
  }

  const persist = (value: string) => {
    vscode.postMessage({
      type: "routineInboxDraft",
      requestID: crypto.randomUUID(),
      agentID: props.agentID,
      draft: value.trim() ? value : null,
    })
  }

  const unsub = vscode.onMessage(receive)
  onCleanup(() => {
    unsub()
    if (!timer) return
    clearTimeout(timer)
    persist(note())
  })

  const change = (value: string) => {
    setNote(value)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => persist(value), 400)
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

  const stop = (id: string) => {
    if (halt() === "sending") return
    setHalt("sending")
    setError("")
    haltID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineDelegateCancel",
      requestID: haltID,
      agentID: props.agentID,
      id,
    })
  }

  const show = (id: string) => {
    if (look()) return
    setLook(id)
    lookID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineDelegateChain",
      requestID: lookID,
      agentID: props.agentID,
      id,
    })
  }

  return (
    <div
      ref={frame}
      class="routines-thread"
      role="region"
      tabIndex={-1}
      aria-label={`Conversation with ${props.name}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !props.onBack) return
        event.preventDefault()
        props.onBack()
      }}
    >
      <header class="routines-thread-head">
        <Show when={props.onBack}>
          <Button variant="ghost" size="small" aria-label={`Back to ${props.name}`} onClick={props.onBack}>
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
        role="log"
        tabIndex={0}
        aria-label={`Messages with ${props.name}`}
        aria-relevant="additions"
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
          {(item) => {
            const id = linked(item)
            return (
              <Line
                item={item}
                rows={thread()}
                busy={halt() === "sending"}
                look={look()}
                tree={id ? trees()[id] : undefined}
                fault={id ? faults()[id] : undefined}
                onStop={stop}
                onShow={show}
              />
            )
          }}
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
        <Show when={props.box?.state === "paused"}>
          <p class="routines-hint">
            This worker is paused. Follow-ups still arrive here. Scheduled starts stay off until it is enabled.
          </p>
        </Show>
        <Button type="button" size="small" disabled={phase() === "sending" || !note().trim()} onClick={submit}>
          {phase() === "sending" ? "Asking this worker" : phase() === "failed" ? "Retry follow-up" : "Send"}
        </Button>
      </form>
      <Show when={props.workers && props.workers.length > 0}>
        <Pass agentID={props.agentID} workers={props.workers!} runID={props.runID} onDone={() => { wait = false; load() }} />
      </Show>
    </div>
  )
}
