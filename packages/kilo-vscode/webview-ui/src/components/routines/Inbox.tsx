import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ConnectionState, ExtensionMessage } from "../../types/messages"
import { routineFailure } from "../../utils/routine-recovery"
import { ChatInfo } from "./ChatInfo"
import { ConversationSearch } from "./ConversationSearch"
import { ConversationState } from "./ConversationState"
import { MediaAttachment, previewable } from "./MediaAttachment"
import { MessageTime } from "../chat/MessageTime"

const RESTORE_PAGE_LIMIT = 20

export type Note = {
  id: string
  agentID: string
  kind: "user" | "worker" | "report" | "decision" | "delegation" | "system"
  source: string
  body: string
  occurrenceID?: string
  sessionID?: string
  files?: { name: string; path: string }[]
  attachments?: DraftFile[]
  time: number
}

export type DraftFile = { id: string; name: string; mime: string; size: number }

type Draft = { body: string; files: DraftFile[]; at: number }

type InboxState = Record<string, unknown> & {
  routineInbox?: Record<string, unknown> & { drafts?: Record<string, Draft> }
}

function draftKey(agentID: string) {
  return `agent:${agentID}`
}

function draftState(value: unknown): Draft | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  const files = Array.isArray(row.files)
    ? row.files.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const id = (item as { id?: unknown }).id
        const name = (item as { name?: unknown }).name
        const mime = (item as { mime?: unknown }).mime
        const size = (item as { size?: unknown }).size
        return typeof id === "string" &&
          typeof name === "string" &&
          typeof mime === "string" &&
          typeof size === "number" &&
          Number.isFinite(size) &&
          id &&
          name
          ? [{ id, name, mime, size }]
          : []
      })
    : []
  if (typeof row.body !== "string" || typeof row.at !== "number" || !Number.isFinite(row.at)) return
  return { body: row.body, files: files.slice(0, 8), at: row.at }
}

function attachments(value: unknown): DraftFile[] {
  if (!Array.isArray(value)) return []
  return value.filter((file): file is DraftFile => {
    if (!file || typeof file !== "object") return false
    const row = file as Record<string, unknown>
    return (
      typeof row.id === "string" &&
      !!row.id &&
      typeof row.name === "string" &&
      !!row.name &&
      typeof row.mime === "string" &&
      typeof row.size === "number" &&
      Number.isFinite(row.size)
    )
  })
}

function missing(id: string | undefined, rows: Note[]) {
  return !!id && !rows.some((item) => item.id === id)
}

function removeLabel(id: string, active: string, failed: string) {
  if (active === id) return "Removing"
  if (failed === id) return "Retry remove"
  return "Remove"
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
  draftAttachments?: DraftFile[]
  draftRevision?: number
}

function draftVersion(box?: Box) {
  return box?.draftRevision ?? 0
}

export type Anchor = {
  id: string
  offset: number
}

type Peer = {
  id: string
  name: string
  role: string
  enabled?: boolean
  dir?: string
}

function folder(value?: string) {
  const path = value?.trim()
  if (!path) return
  return path.replaceAll("\\", "/").replace(/\/+$/, "")
}

function away(item: Peer, workspace?: string) {
  const from = folder(workspace)
  const to = folder(item.dir)
  return !!(from && to && from !== to)
}

function ready(item: Peer, workspace?: string) {
  if (item.enabled === false) return false
  if (away(item, workspace)) return false
  return true
}

function caption(item: Peer, phase: "idle" | "sending" | "failed", workspace?: string) {
  if (phase === "sending") return "Asking"
  if (item.enabled === false) return `${item.name} is paused`
  if (away(item, workspace)) return `${item.name} is in another folder`
  if (phase === "failed") return `Retry ask ${item.name}`
  return `Ask ${item.name}`
}

function kind(value: Note["kind"], source?: string) {
  if (value === "system") return "Update"
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
  disabled: boolean
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
        disabled={props.busy || props.disabled}
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
  disabled: boolean
  look: string
  tree?: Tree
  fault?: string
  onStop: (id: string) => void
  onShow: (id: string) => void
}> = (props) => {
  const live = () => pending(props.item, props.rows)
  const id = () => linked(props.item)
  return (
    <article
      class="routines-line"
      data-kind={props.item.kind}
      data-source={props.item.source}
      data-routine-message={props.item.id}
    >
      <span class="routines-line-meta">
        {kind(props.item.kind, props.item.source)} · <MessageTime value={props.item.time} side="routine" />
      </span>
      <p class="routines-line-body">{props.item.body}</p>
      <Files items={props.item.files} session={props.item.sessionID} />
      <Attachments agentID={props.item.agentID} items={props.item.attachments} />
      <Show when={live()}>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={props.busy || props.disabled}
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
            disabled={props.disabled}
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

function size(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export const Attachments: Component<{ agentID: string; items?: DraftFile[] }> = (props) => {
  const vscode = useVSCode()
  return (
    <Show when={props.items?.length}>
      <ul class="routines-files" aria-label="Message attachments">
        <For each={props.items}>
          {(file) =>
            previewable(file.mime) ? (
              <MediaAttachment agentID={props.agentID} file={file} />
            ) : (
              <li>
                <button
                  type="button"
                  class="routines-file"
                  aria-label={`Open ${file.name}`}
                  onClick={() =>
                    vscode.postMessage({
                      type: "routineInboxAttachmentOpen",
                      requestID: crypto.randomUUID(),
                      agentID: props.agentID,
                      attachmentID: file.id,
                    })
                  }
                >
                  <span class="routines-file-name">{file.name}</span>
                  <span class="routines-file-path">
                    {file.mime} · {size(file.size)}
                  </span>
                </button>
              </li>
            )
          }
        </For>
      </ul>
    </Show>
  )
}

export function status(state: Box["state"]) {
  if (state === "needs_input") return "Waiting for your answer"
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

const Pass: Component<{
  agentID: string
  workers: Peer[]
  workspace?: string
  runID?: string
  connected: boolean
  onDone?: () => void
}> = (props) => {
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

  createEffect(() => {
    if (props.connected || phase() !== "sending") return
    setPhase("failed")
    setError("The connection was lost before Raya confirmed this request. Reconnect, then retry.")
    setNews("")
  })

  const receive = (msg: ExtensionMessage) => {
    if (msg.type !== "routineDelegated" || msg.requestID !== sendID || msg.agentID !== props.agentID) return
    if (msg.error) {
      setPhase("failed")
      setError(routineFailure(msg.error, msg.recovery, "Your draft and attachments are still here."))
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
    if (!props.connected || !body || phase() === "sending" || (peer && !ready(peer, props.workspace))) return
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
      <Show when={props.workers.some((item) => item.enabled === false)}>
        <p class="routines-hint">Paused workers cannot start a new request until they are enabled.</p>
      </Show>
      <Show when={props.workers.some((item) => away(item, props.workspace))}>
        <p class="routines-hint">Workers in another folder cannot take this request.</p>
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
            disabled={!props.connected || phase() === "sending" || !ask().trim() || !ready(item, props.workspace)}
            onClick={() => submit(item.id)}
          >
            {caption(item, phase(), props.workspace)}
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
  objective: string
  schedule: string
  access: string
  output: string
  enabled: boolean
  canInspect: boolean
  connection: ConnectionState
  onEdit: () => void
  onAccess: () => void
  onOutput: () => void
  onInspect: () => void
  onToggle: () => void
  anchor?: Anchor
  onAnchor?: (value?: Anchor) => void
  onBack?: () => void
}> = (props) => {
  const vscode = useVSCode()
  const ready = () => !!props.box
  const connected = () => props.connection === "connected"
  const [thread, setThread] = createSignal<Note[]>([])
  const [cursor, setNext] = createSignal<string>()
  const [note, setNote] = createSignal("")
  const [files, setFiles] = createSignal<DraftFile[]>([])
  const [picking, setPicking] = createSignal(false)
  const [pickFailed, setPickFailed] = createSignal(false)
  const [removing, setRemoving] = createSignal("")
  const [removeFailed, setRemoveFailed] = createSignal("")
  const [passing, setPassing] = createSignal(false)
  const [info, setInfo] = createSignal(false)
  const [infoReady, setInfoReady] = createSignal(false)
  const [phase, setPhase] = createSignal<"idle" | "sending" | "failed">("idle")
  const [error, setError] = createSignal("")
  const [halt, setHalt] = createSignal<"idle" | "sending" | "failed">("idle")
  const [look, setLook] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [pageError, setPageError] = createSignal("")
  const [searching, setSearching] = createSignal(false)
  const [trees, setTrees] = createSignal<Record<string, Tree>>({})
  const [faults, setFaults] = createSignal<Record<string, string>>({})
  const [trail, setTrail] = createSignal<{ id: string; name: string }>()
  const [locating, setLocating] = createSignal<{ id: string; label: string; phase: "finding" | "showing" }>()
  const [searchRevision, setSearchRevision] = createSignal(0)
  const removeDisabled = (id: string) =>
    !ready() || !connected() || phase() === "sending" || (!!removing() && removing() !== id)
  const attachDisabled = () =>
    !ready() || !connected() || phase() === "sending" || picking() || !!removing() || files().length >= 8
  const sendDisabled = () =>
    !ready() || !connected() || phase() === "sending" || (!note().trim() && files().length === 0)
  let source = `user:${crypto.randomUUID()}`
  let pageID = ""
  let sendID = ""
  let pickID = ""
  let haltID = ""
  let lookID = ""
  let older = false
  let wait = false
  let stick = true
  let target: Anchor | undefined
  let mark = ""
  let depth = 0
  let seen = ""
  let server = ""
  let term = ""
  let pane: HTMLDivElement | undefined
  let frame: HTMLDivElement | undefined
  let infoRef: HTMLButtonElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let connection = props.connection
  let draftRevision = 0
  let dirty = false
  const saves = new Map<string, number>()

  const version = (id: string) => {
    draftRevision++
    saves.set(id, draftRevision)
    while (saves.size > 64) {
      const first = saves.keys().next().value
      if (first) saves.delete(first)
      else break
    }
    return draftRevision
  }

  const viewState = () => {
    const value = vscode.getState<InboxState>()
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as InboxState
    return value
  }

  const local = () => draftState(viewState().routineInbox?.drafts?.[draftKey(props.agentID)])

  const rememberDraft = (body = note(), rows = files()) => {
    const state = viewState()
    const inbox = state.routineInbox ?? {}
    const drafts = { ...(inbox.drafts ?? {}) }
    const key = draftKey(props.agentID)
    if (body || rows.length) drafts[key] = { body, files: rows.slice(0, 8), at: Date.now() }
    else delete drafts[key]
    const kept = Object.entries(drafts)
      .map(([id, value]) => [id, draftState(value)] as const)
      .filter((entry): entry is readonly [string, Draft] => !!entry[1])
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 64)
    vscode.setState<InboxState>({ ...state, routineInbox: { ...inbox, drafts: Object.fromEntries(kept) } })
  }

  const load = (after?: string, search?: string) => {
    if (wait || !connected()) return
    wait = true
    older = !!after
    setLoading(true)
    setPageError("")
    pageID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineInboxPage",
      requestID: pageID,
      agentID: props.agentID,
      ...(after ? { cursor: after } : {}),
      ...(search ? { search } : {}),
    })
  }

  const pin = () => {
    if (!stick || !pane) return
    pane.scrollTop = pane.scrollHeight
  }

  const refresh = (latest?: string) => {
    if (term || !missing(latest, thread())) return
    load()
  }

  const place = () => {
    if (!target || !pane) {
      pin()
      return
    }
    const key = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(target.id) : target.id
    const row = pane.querySelector<HTMLElement>(`[data-routine-message="${key}"]`)
    if (row) {
      pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - target.offset
      stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48
      const item = locating()
      if (item?.id === target.id) setLocating({ ...item, phase: "showing" })
      target = undefined
      return
    }
    const next = cursor()
    if (next && !wait && depth < RESTORE_PAGE_LIMIT) {
      depth++
      load(next)
      return
    }
    const item = locating()
    if (item?.id === target.id) {
      setLocating()
      setError(`The message that shared ${item.label} is no longer available in retained history.`)
    }
    target = undefined
    stick = true
    props.onAnchor?.()
    pin()
  }

  const remember = () => {
    if (!pane) return
    stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48
    if (stick) {
      props.onAnchor?.()
      return
    }
    const top = pane.getBoundingClientRect().top
    const row = [...pane.querySelectorAll<HTMLElement>("[data-routine-message]")].find(
      (item) => item.getBoundingClientRect().bottom > top,
    )
    const id = row?.dataset.routineMessage
    if (!row || !id) return
    props.onAnchor?.({ id, offset: row.getBoundingClientRect().top - top })
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
      setLoading(true)
      setPageError("")
      term = ""
      setSearching(false)
      setLook("")
      setTrees({})
      setFaults({})
      setTrail()
      setLocating()
      setError("")
      const draft = local()
      setNote(draft?.body ?? "")
      setFiles(draft?.files ?? [])
      setPicking(false)
      setPickFailed(false)
      setRemoving("")
      setRemoveFailed("")
      setInfo(false)
      setInfoReady(false)
      stick = true
      depth = 0
      server = ""
      draftRevision = draftVersion(props.box)
      dirty = false
      saves.clear()
      if (props.box) {
        server = id
        setNote(props.box.draft ?? "")
        setFiles(props.box.draftAttachments ?? [])
        rememberDraft(props.box.draft ?? "", props.box.draftAttachments ?? [])
      }
      load()
      queueMicrotask(() => frame?.focus())
      return
    }
    draftRevision = Math.max(draftRevision, draftVersion(props.box))
    if (props.box && server !== id) {
      server = id
      setNote(props.box.draft ?? "")
      setFiles(props.box.draftAttachments ?? [])
      rememberDraft(props.box.draft ?? "", props.box.draftAttachments ?? [])
    }
    refresh(latest)
  })

  createEffect(() => {
    const state = props.connection
    if (state === connection) return
    connection = state
    if (state !== "connected") {
      pageID = crypto.randomUUID()
      wait = false
      setLoading(false)
      setPageError("")
      if (phase() === "sending") {
        setPhase("failed")
        setError(
          "The connection was lost before Raya confirmed this message. Your draft is still here. Reconnect, then retry.",
        )
      }
      if (picking()) {
        setPicking(false)
        setPickFailed(true)
        setError("The connection was lost before Raya confirmed the attachment. Reconnect, then retry.")
      }
      const removal = removing()
      if (removal) {
        setRemoving("")
        setRemoveFailed(removal)
        setError("The connection was lost before Raya confirmed the attachment change. Reconnect, then retry.")
      }
      if (halt() === "sending") {
        setHalt("failed")
        setError("The connection was lost before Raya confirmed the stop request. Reconnect, then retry.")
      }
      if (look()) {
        setFaults((prior) => ({ ...prior, [look()]: "Reconnect to read this request chain." }))
        setLook("")
      }
      return
    }
    wait = false
    setPageError("")
    load(undefined, term || undefined)
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    persist(note())
  })

  const page = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxPage" || msg.requestID !== pageID || msg.agentID !== props.agentID) return
    wait = false
    setLoading(false)
    if (msg.error) {
      setPageError(routineFailure(msg.error, msg.recovery, "Messages already loaded are still here."))
      return
    }
    const rows = Array.isArray(msg.messages) ? (msg.messages as Note[]) : []
    setThread((prior) => (older ? [...rows, ...prior] : rows))
    setNext(msg.next)
    setPageError("")
    setError("")
    const last = rows.at(-1)
    if (last && !older)
      vscode.postMessage({
        type: "routineInboxRead",
        requestID: crypto.randomUUID(),
        agentID: props.agentID,
        at: last.time,
      })
    queueMicrotask(place)
  }

  const sent = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxSent" || msg.requestID !== sendID || msg.agentID !== props.agentID) return
    if (msg.error) {
      setPhase("failed")
      setError(routineFailure(msg.error, msg.recovery, "Your draft and attachments are still here."))
      return
    }
    const saved = msg.message as Note | undefined
    if (saved?.id && (!term || saved.body.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
      setThread((prior) => (prior.some((item) => item.id === saved.id) ? prior : [...prior, saved]))
    source = `user:${crypto.randomUUID()}`
    setNote("")
    setFiles([])
    rememberDraft("", [])
    dirty = false
    setPhase("idle")
    setError("")
    const requestID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineInboxDraft",
      requestID,
      agentID: props.agentID,
      draft: null,
      attachmentIDs: null,
      revision: version(requestID),
    })
    stick = true
    queueMicrotask(pin)
  }

  const picked = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxFiles" || msg.requestID !== pickID || msg.agentID !== props.agentID) return
    const sent = saves.get(msg.requestID)
    saves.delete(msg.requestID)
    const removal = removing()
    setPicking(false)
    setRemoving("")
    if (sent === undefined || sent < draftRevision) return
    if (msg.revision !== undefined && msg.revision !== sent) {
      if (removal) setRemoveFailed(removal)
      else setPickFailed(true)
      setError("Raya returned a different draft version. Your text is still here; refresh before trying again.")
      return
    }
    if (msg.error) {
      if (removal) setRemoveFailed(removal)
      else setPickFailed(true)
      setError(routineFailure(msg.error, msg.recovery, "Your draft and attachments are still here."))
      return
    }
    const rows = attachments(msg.files)
    setFiles(rows)
    rememberDraft(typeof msg.draft === "string" ? msg.draft : note(), rows)
    setPickFailed(false)
    setRemoveFailed("")
    setError("")
    if (dirty) persist(note())
  }

  const saved = (msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxDraft" || msg.agentID !== props.agentID) return
    const sent = saves.get(msg.requestID)
    if (sent === undefined) return
    saves.delete(msg.requestID)
    if (sent < draftRevision) return
    if (msg.revision !== undefined && msg.revision !== sent) {
      dirty = true
      setError("Raya returned a different draft version. Your text is still here; refresh before saving again.")
      return
    }
    if (!msg.error) return
    dirty = true
    setError(
      msg.recovery?.kind === "conflict"
        ? "This draft changed in another Raya window. Your text and attachments are still here; refresh before saving again."
        : routineFailure(msg.error, msg.recovery, "Your text and attachments are still here."),
    )
  }

  const halted = (msg: ExtensionMessage) => {
    if (msg.type !== "routineDelegateStopped" || msg.requestID !== haltID || msg.agentID !== props.agentID) return
    if (msg.error) {
      setHalt("failed")
      setError(routineFailure(msg.error, msg.recovery))
      return
    }
    setHalt("idle")
    setError("")
    wait = false
    load(undefined, term || undefined)
  }

  const chained = (msg: ExtensionMessage) => {
    if (msg.type !== "routineDelegateChain" || msg.requestID !== lookID || msg.agentID !== props.agentID) return
    const id = typeof msg.id === "string" ? msg.id : look()
    if (msg.error) {
      if (id)
        setFaults((prior) => ({
          ...prior,
          [id]: routineFailure(msg.error, msg.recovery) || "The request chain could not be read.",
        }))
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
    picked(msg)
    saved(msg)
    halted(msg)
    chained(msg)
    if (msg.type === "routineInboxAttachmentOpened" && msg.agentID === props.agentID && msg.error)
      setError(routineFailure(msg.error, msg.recovery))
  }

  const persist = (value: string) => {
    if (!connected() || picking() || !!removing() || phase() === "sending") return
    const requestID = crypto.randomUUID()
    dirty = false
    vscode.postMessage({
      type: "routineInboxDraft",
      requestID,
      agentID: props.agentID,
      draft: value.trim() ? value : null,
      attachmentIDs: files().length ? files().map((file) => file.id) : null,
      revision: version(requestID),
    })
  }

  const unsub = vscode.onMessage(receive)
  onCleanup(() => {
    unsub()
    remember()
    if (!timer) return
    clearTimeout(timer)
    persist(note())
  })

  createEffect(() => {
    const id = props.anchor?.id ?? ""
    const offset = props.anchor?.offset ?? 0
    const next = `${id}:${offset}`
    if (!id || next === mark) return
    mark = next
    target = { id, offset }
    stick = false
    depth = 0
    if (thread().length) queueMicrotask(place)
  })

  const change = (value: string) => {
    setNote(value)
    rememberDraft(value, files())
    dirty = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => persist(value), 400)
  }

  const search = (value: string) => {
    if (!connected()) return
    setLocating()
    target = undefined
    depth = 0
    wait = false
    older = false
    stick = true
    term = value
    setSearching(!!value)
    setThread([])
    setNext()
    setPageError("")
    setError("")
    load(undefined, term || undefined)
  }

  const retry = () => {
    if (!connected()) return
    const after = older ? cursor() : undefined
    wait = false
    load(after, term || undefined)
  }

  const submit = () => {
    const body = note().trim()
    if (!connected() || (!body && files().length === 0) || phase() === "sending") return
    setPhase("sending")
    setError("")
    if (timer) clearTimeout(timer)
    timer = undefined
    sendID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineInboxSend",
      requestID: sendID,
      agentID: props.agentID,
      source,
      body,
      ...(files().length ? { attachmentIDs: files().map((file) => file.id) } : {}),
    })
  }

  const attach = () => {
    if (!connected() || picking() || files().length >= 8) return
    setPicking(true)
    setPickFailed(false)
    setError("")
    pickID = crypto.randomUUID()
    if (timer) clearTimeout(timer)
    timer = undefined
    dirty = false
    vscode.postMessage({
      type: "routineInboxFilesPick",
      requestID: pickID,
      agentID: props.agentID,
      draft: note().trim() ? note() : null,
      ...(files().length ? { attachmentIDs: files().map((file) => file.id) } : {}),
      revision: version(pickID),
    })
  }

  const remove = (id: string) => {
    const next = files().filter((file) => file.id !== id)
    if (!connected() || removing() || phase() === "sending") return
    setRemoving(id)
    setRemoveFailed("")
    setError("")
    pickID = crypto.randomUUID()
    if (timer) clearTimeout(timer)
    timer = undefined
    dirty = false
    vscode.postMessage({
      type: "routineInboxFilesForget",
      requestID: pickID,
      agentID: props.agentID,
      draft: note().trim() ? note() : null,
      attachmentIDs: next.length ? next.map((file) => file.id) : null,
      revision: version(pickID),
    })
  }

  const stop = (id: string) => {
    if (!connected() || halt() === "sending") return
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
    if (!connected() || look()) return
    setLook(id)
    lookID = crypto.randomUUID()
    vscode.postMessage({
      type: "routineDelegateChain",
      requestID: lookID,
      agentID: props.agentID,
      id,
    })
  }

  const follow = (id: string, name: string) => {
    setInfo(false)
    setPassing(false)
    setTrail({ id, name })
    const row = thread().find((item) => item.occurrenceID === id)
    if (row) {
      target = { id: row.id, offset: 0 }
      stick = false
      queueMicrotask(place)
    }
    if (look()) setLook("")
    show(id)
  }

  const latest = () => {
    pageID = crypto.randomUUID()
    wait = false
    target = undefined
    depth = 0
    stick = true
    setLocating()
    setError("")
    load()
  }

  const locate = (id: string, label: string) => {
    setInfo(false)
    setPassing(false)
    setTrail()
    setError("")
    setPageError("")
    setLocating({ id, label, phase: "finding" })
    target = { id, offset: 0 }
    depth = 0
    stick = false
    if (term) {
      term = ""
      setSearching(false)
      setSearchRevision((value) => value + 1)
      pageID = crypto.randomUUID()
      wait = false
      setThread([])
      setNext()
      load()
      return
    }
    queueMicrotask(place)
  }

  return (
    <div
      ref={frame}
      class="routines-thread"
      role="region"
      tabIndex={-1}
      aria-label={`Conversation with ${props.name}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        if (info()) {
          setInfo(false)
          queueMicrotask(() => infoRef?.focus())
          return
        }
        if (trail()) {
          setTrail()
          queueMicrotask(() => infoRef?.focus())
          return
        }
        if (locating()) {
          latest()
          queueMicrotask(() => infoRef?.focus())
          return
        }
        if (!props.onBack) return
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
          <strong tabIndex={-1}>{props.name}</strong>
          <span class="routines-meta">
            {props.role}
            <Show when={props.workspace}> · {props.workspace}</Show>
            {` · ${status(props.box?.state ?? "scheduled")}`}
            <Show when={props.box?.nextRun}>
              {(at) => (
                <>
                  {" · Next "}
                  <MessageTime value={at()} side="routine" detail="date-time" />
                </>
              )}
            </Show>
          </span>
        </div>
        <Show when={!info() && props.workers && props.workers.length > 0}>
          <Button
            variant="ghost"
            size="small"
            disabled={!connected()}
            aria-expanded={passing()}
            onClick={() => setPassing((value) => !value)}
          >
            Delegate
          </Button>
        </Show>
        <Button
          ref={infoRef}
          variant="ghost"
          size="small"
          aria-expanded={info()}
          aria-pressed={info()}
          onClick={() => {
            if (!info()) setInfoReady(true)
            setInfo((value) => !value)
          }}
        >
          Info
        </Button>
      </header>
      <div class="routines-conversation" hidden={info()}>
        <ConversationSearch
          agentID={props.agentID}
          name={props.name}
          disabled={!connected()}
          reset={searchRevision()}
          onSearch={search}
        />
        <Show when={!connected()}>
          <p class="routines-offline" role="status" aria-live="polite">
            Offline. Your messages and draft stay here. This conversation will refresh when Raya reconnects.
          </p>
        </Show>
        <Show when={locating()} keyed>
          {(item) => (
            <div class="routines-located" role="status" aria-live="polite">
              <span>
                {item.phase === "finding"
                  ? `Finding where ${item.label} was shared…`
                  : `Showing where ${item.label} was shared.`}
              </span>
              <Show when={item.phase === "showing"}>
                <Button type="button" size="small" variant="ghost" disabled={!connected()} onClick={latest}>
                  Return to latest
                </Button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={trail()} keyed>
          {(item) => (
            <section class="routines-lineage" aria-label={`Request chain with ${item.name}`}>
              <div class="routines-lineage-head">
                <strong>Request chain with {item.name}</strong>
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    setTrail()
                    queueMicrotask(() => infoRef?.focus())
                  }}
                >
                  Close
                </Button>
              </div>
              <Trace
                id={item.id}
                busy={look() === item.id}
                disabled={!connected()}
                tree={trees()[item.id]}
                error={faults()[item.id]}
                onShow={show}
              />
            </section>
          )}
        </Show>
        <div
          ref={pane}
          class="routines-thread-body"
          role="log"
          tabIndex={0}
          aria-busy={loading()}
          aria-label={`Messages with ${props.name}`}
          aria-relevant="additions"
          onScroll={remember}
        >
          <Show when={cursor()}>
            <Button
              variant="ghost"
              size="small"
              disabled={loading() || !connected()}
              onClick={() => {
                const after = cursor()
                if (after) load(after, term || undefined)
              }}
            >
              {loading() && older ? "Loading earlier messages" : "Earlier messages"}
            </Button>
          </Show>
          <Show when={!thread().length && connected()}>
            <ConversationState loading={loading()} searching={searching()} error={pageError()} onRetry={retry} />
          </Show>
          <For each={thread()}>
            {(item) => {
              const id = linked(item)
              return (
                <Line
                  item={item}
                  rows={thread()}
                  busy={halt() === "sending"}
                  disabled={!connected()}
                  look={look()}
                  tree={id ? trees()[id] : undefined}
                  fault={id ? faults()[id] : undefined}
                  onStop={stop}
                  onShow={show}
                />
              )
            }}
          </For>
          <Show when={thread().length > 0 && pageError()}>
            <div class="routines-load-error" role="alert">
              <p>{pageError()}</p>
              <Button type="button" size="small" variant="ghost" disabled={!connected()} onClick={retry}>
                Retry
              </Button>
            </div>
          </Show>
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
          <Show when={files().length}>
            <ul class="routines-draft-files" aria-label="Files ready to send">
              <For each={files()}>
                {(file) => (
                  <li>
                    <span title={file.name}>{file.name}</span>
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      disabled={removeDisabled(file.id)}
                      aria-label={`Remove ${file.name}`}
                      onClick={() => remove(file.id)}
                    >
                      {removeLabel(file.id, removing(), removeFailed())}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <label class="routines-field routines-compose-field">
            <span class="sr-only">Message this worker</span>
            <textarea
              value={note()}
              disabled={!ready()}
              rows={2}
              aria-label="Message this worker"
              placeholder="Ask about a report in this conversation."
              onInput={(event) => change(event.currentTarget.value)}
            />
          </label>
          <Show when={props.box?.state === "paused"}>
            <p class="routines-hint">
              This worker is paused. Follow-ups still arrive here. Scheduled starts stay off until it is enabled.
            </p>
          </Show>
          <div class="routines-compose-actions">
            <Button type="button" size="small" variant="ghost" disabled={attachDisabled()} onClick={attach}>
              {picking() ? "Saving attachment…" : pickFailed() ? "Retry attach" : "Attach"}
            </Button>
            <Button type="button" size="small" disabled={sendDisabled()} onClick={submit}>
              {phase() === "sending" ? "Sending" : phase() === "failed" ? "Retry" : "Send"}
            </Button>
          </div>
        </form>
        <Show when={passing() && props.workers && props.workers.length > 0}>
          <Pass
            agentID={props.agentID}
            workers={props.workers!}
            workspace={props.workspace}
            runID={props.runID}
            connected={connected()}
            onDone={() => {
              wait = false
              load(undefined, term || undefined)
            }}
          />
        </Show>
      </div>
      <Show when={infoReady()}>
        <div class="routines-info-shell" hidden={!info()}>
          <ChatInfo
            agentID={props.agentID}
            name={props.name}
            role={props.role}
            objective={props.objective}
            schedule={props.schedule}
            access={props.access}
            output={props.output}
            state={status(props.box?.state ?? "scheduled")}
            workspace={props.workspace}
            enabled={props.enabled}
            canInspect={props.canInspect}
            connected={connected()}
            onEdit={props.onEdit}
            onAccess={props.onAccess}
            onOutput={props.onOutput}
            onInspect={props.onInspect}
            onToggle={props.onToggle}
            onLocate={locate}
            onTrace={follow}
          />
        </div>
      </Show>
    </div>
  )
}
