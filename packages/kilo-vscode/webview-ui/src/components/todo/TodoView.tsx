import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Select } from "@kilocode/kilo-ui/select"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage, FocusTimerItem, PersonalTodoItem, PersonalTodoProposalView } from "../../types/messages"
import { TodoProposalCard, type TodoProposal, type TodoProposalIssue } from "./TodoProposalCard"

type Intent =
  | { operation: "create"; title: string; reminderAt?: number }
  | { operation: "update"; todoID: string; changes: Changes }
  | { operation: "delete"; todoID: string }

type Changes = {
  title?: string
  detail?: string | null
  done?: boolean
  dueAt?: number | null
  reminderAt?: number | null
}
type Edit = { todoID: string; title: string; detail: string; due: string; reminder: string }
type Notice = { kind: "offline" | "stale" | "error"; message: string }
type TimerIntent =
  | { operation: "start"; durationMs: number; todoID?: string }
  | { operation: "pause" | "resume" | "reset" }
type ProposalIntent =
  | { operation: "list" }
  | { operation: "get"; proposalID: string; digest: string }
  | { operation: "apply" | "reject"; proposalID: string; digest: string }
type ProposalFocus = { nonce: string; id: string; digest: string }

const durations = [
  { label: "15 minutes", value: 15 * 60_000 },
  { label: "25 minutes", value: 25 * 60_000 },
  { label: "45 minutes", value: 45 * 60_000 },
  { label: "1 hour", value: 60 * 60_000 },
]

const order = (items: PersonalTodoItem[]) =>
  [...items].sort((a, b) => {
    const rank = { urgent: 4, high: 3, medium: 2, low: 1 }
    const score = (item: PersonalTodoItem) =>
      (item.dueAt && item.dueAt < Date.now() ? 8 : 0) + (item.priority ? rank[item.priority] : 0)
    return (
      Number(a.done) - Number(b.done) ||
      score(b) - score(a) ||
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
      b.updatedAt - a.updatedAt
    )
  })

const local = (value?: number) => {
  if (value === undefined) return ""
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(value - offset).toISOString().slice(0, 16)
}

const due = (value: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))

const proposal = (view: PersonalTodoProposalView): TodoProposal => ({
  id: view.proposal.id,
  title: view.proposal.changes.title ?? (view.proposal.target.kind === "existing" ? "Update this Todo" : "New Todo"),
  detail: view.proposal.changes.detail,
  priority: view.proposal.changes.priority,
  estimateMinutes: view.proposal.changes.estimateMinutes,
  dueAt: view.proposal.changes.dueAt,
  reminderAt: view.proposal.changes.reminderAt,
  links: view.proposal.changes.links,
  subtasks: view.proposal.changes.subtasks?.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    notes: item.notes,
    priority: item.priority,
    estimateMinutes: item.estimateMinutes,
    dueAt: item.dueAt,
    links: item.links,
  })),
})

export const TodoView: Component<{
  onBack: () => void
  focus?: ProposalFocus
  onFocusConsumed?: () => void
  onEditProposal?: (id: string) => void
  onAskRaya?: (text: string) => void
}> = (props) => {
  const vscode = useVSCode()
  const [items, setItems] = createSignal<PersonalTodoItem[]>([])
  const [draft, setDraft] = createSignal("")
  const [askDraft, setAskDraft] = createSignal("")
  const [filter, setFilter] = createSignal<"all" | "today" | "important" | "scheduled" | "done">("all")
  const [reminder, setReminder] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [notice, setNotice] = createSignal<Notice>()
  const [confirming, setConfirming] = createSignal<string>()
  const [editing, setEditing] = createSignal<Edit>()
  const [editError, setEditError] = createSignal<string>()
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
  const [proposals, setProposals] = createSignal<PersonalTodoProposalView[]>([])
  const [proposalLoading, setProposalLoading] = createSignal(true)
  const [proposalNotice, setProposalNotice] = createSignal<TodoProposalIssue>()
  const [proposalBusy, setProposalBusy] = createSignal<Record<string, "apply" | "reject">>({})
  const [proposalIssues, setProposalIssues] = createSignal<Record<string, TodoProposalIssue | undefined>>({})
  const [proposalRecovery, setProposalRecovery] = createSignal<Record<string, ProposalIntent | undefined>>({})
  const [settled, setSettled] = createSignal<ReadonlySet<string>>(new Set())
  const requests = new Map<string, Intent | { operation: "list" }>()
  const timers = new Map<string, TimerIntent | { operation: "get" }>()
  const proposalRequests = new Map<string, ProposalIntent>()

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
      vscode.postMessage({
        type: "personalTodoCreate",
        requestID,
        title: intent.title,
        reminderAt: intent.reminderAt,
      })
    if (intent.operation === "update" && item)
      vscode.postMessage({
        type: "personalTodoUpdate",
        requestID,
        todoID: item.id,
        revision: item.revision,
        ...intent.changes,
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

  const replaceProposal = (item: PersonalTodoProposalView) =>
    setProposals((rows) =>
      rows.some((row) => row.proposal.id === item.proposal.id)
        ? rows.map((row) => (row.proposal.id === item.proposal.id ? item : row))
        : [...rows, item],
    )

  const sendProposal = (intent: ProposalIntent) => {
    const requestID = crypto.randomUUID()
    proposalRequests.set(requestID, intent)
    if (intent.operation === "list") {
      setProposalLoading(true)
      setProposalNotice()
      vscode.postMessage({ type: "personalTodoProposalList", requestID })
      return
    }
    if (intent.operation === "get") {
      vscode.postMessage({ type: "personalTodoProposalGet", requestID, proposalID: intent.proposalID })
      return
    }
    setProposalBusy((state) => ({ ...state, [intent.proposalID]: intent.operation }))
    setProposalIssues((state) => ({ ...state, [intent.proposalID]: undefined }))
    setProposalRecovery((state) => ({ ...state, [intent.proposalID]: undefined }))
    vscode.postMessage({
      type: intent.operation === "apply" ? "personalTodoProposalApply" : "personalTodoProposalReject",
      requestID,
      proposalID: intent.proposalID,
      digest: intent.digest,
    })
  }

  const focusProposal = (id: string) =>
    queueMicrotask(() => {
      const item = document.querySelector<HTMLElement>(`[data-proposal-id="${CSS.escape(id)}"]`)
      if (!item) return
      item.scrollIntoView({ block: "nearest" })
      const target =
        item.querySelector<HTMLElement>("button:not([disabled])") ??
        item.querySelector<HTMLElement>("[data-slot='todo-proposal-status']")
      target?.focus()
    })

  type ProposalMessage = Extract<ExtensionMessage, { type: "personalTodoProposalResult" }>

  const issue = (message: ProposalMessage): TodoProposalIssue | undefined => {
    if (!("message" in message)) return
    if (
      message.kind !== "offline" &&
      message.kind !== "stale" &&
      message.kind !== "conflict" &&
      message.kind !== "uncertain" &&
      message.kind !== "error"
    )
      return
    return { kind: message.kind, message: message.message }
  }

  const clearProposalBusy = (intent: ProposalIntent) => {
    if (intent.operation !== "apply" && intent.operation !== "reject") return
    setProposalBusy((state) => {
      const next = { ...state }
      delete next[intent.proposalID]
      return next
    })
  }

  const acceptProposal = (message: ProposalMessage, item?: PersonalTodoProposalView) => {
    if (message.kind === "listed") {
      setProposals(message.items)
      setProposalNotice()
      return true
    }
    if (message.kind !== "loaded" && message.kind !== "applied" && message.kind !== "rejected") return false
    const id = item?.proposal.id
    if (!id) return true
    setProposalIssues((state) => ({ ...state, [id]: undefined }))
    setProposalRecovery((state) => ({ ...state, [id]: undefined }))
    focusProposal(id)
    return true
  }

  const failProposal = (intent: ProposalIntent, message: ProposalMessage, item?: PersonalTodoProposalView) => {
    const failure = issue(message)
    if (!failure) return
    if (intent.operation === "list" || intent.operation === "get") {
      setProposalNotice(failure)
      return
    }
    setProposalIssues((state) => ({
      ...state,
      [intent.proposalID]: failure,
    }))
    const recoverable =
      message.kind === "offline" ||
      (message.kind === "uncertain" && item !== undefined && (item.state === "open" || item.state === "pending"))
    setProposalRecovery((state) => ({ ...state, [intent.proposalID]: recoverable ? intent : undefined }))
  }

  const receiveProposal = (message: ProposalMessage) => {
    const intent = proposalRequests.get(message.requestID)
    if (!intent || message.operation !== intent.operation) return
    if (intent.operation !== "list" && message.proposalID !== intent.proposalID) return
    proposalRequests.delete(message.requestID)
    if (intent.operation === "list") setProposalLoading(false)
    clearProposalBusy(intent)
    const item = "item" in message ? message.item : undefined
    if (intent.operation === "get" && item && item.proposal.digest !== intent.digest) {
      setProposalNotice({ kind: "conflict", message: "The saved proposal no longer matches this review." })
      return
    }
    if (item) {
      replaceProposal(item)
      if (intent.operation !== "get") setSettled((ids) => new Set(ids).add(item.proposal.id))
    }
    if (acceptProposal(message, item)) return
    failProposal(intent, message, item)
  }

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
    if (intent.operation === "create") {
      setDraft("")
      setReminder("")
    }
    if (
      intent.operation === "update" &&
      (intent.changes.title !== undefined ||
        intent.changes.detail !== undefined ||
        intent.changes.dueAt !== undefined ||
        intent.changes.reminderAt !== undefined)
    ) {
      setEditing()
      setEditError()
    }
    if (intent.operation === "delete") setConfirming()
  }

  const receive = (message: ExtensionMessage) => {
    if (message.type === "focusTimerResult") return receiveTimer(message)
    if (message.type === "personalTodoProposalResult") return receiveProposal(message)
    if (message.type === "personalTodoResult") receiveTodo(message)
  }

  const unsubscribe = vscode.onMessage(receive)
  onCleanup(unsubscribe)
  onMount(() => {
    send({ operation: "list" })
    sendProposal({ operation: "list" })
    sendTimer({ operation: "get" })
  })

  createEffect(() => {
    const focus = props.focus
    if (!focus) return
    sendProposal({ operation: "get", proposalID: focus.id, digest: focus.digest })
    props.onFocusConsumed?.()
  })

  createEffect(() => {
    if (timer()?.state !== "running") return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => window.clearInterval(id))
  })

  const remaining = createMemo(() => items().filter((item) => !item.done).length)
  const today = createMemo(
    () => items().filter((item) => !item.done && item.dueAt && item.dueAt < new Date().setHours(24, 0, 0, 0)).length,
  )
  const important = createMemo(
    () => items().filter((item) => !item.done && (item.priority === "urgent" || item.priority === "high")).length,
  )
  const scheduled = createMemo(() => items().filter((item) => !item.done && item.dueAt).length)
  const done = createMemo(() => items().filter((item) => item.done).length)
  const visible = createMemo(() =>
    order(items()).filter((item) => {
      if (filter() === "today") return !item.done && !!item.dueAt && item.dueAt < new Date().setHours(24, 0, 0, 0)
      if (filter() === "important") return !item.done && (item.priority === "urgent" || item.priority === "high")
      if (filter() === "scheduled") return !item.done && !!item.dueAt
      if (filter() === "done") return item.done
      return true
    }),
  )
  const ask = (text: string) => props.onAskRaya?.(text)
  const plan = (text: string) => {
    const value = text.trim()
    if (!value) return
    ask(
      `Help me with my Todo: ${value}\n\nUse Raya's native personal Todo tools. If this is a larger goal, propose one clear parent todo with practical subtasks, priorities and reminders where useful. Show me the reviewable proposal before saving. Ask only for a decision that changes the outcome; do not ask for IDs, files, schemas or implementation details.`,
    )
    setAskDraft("")
  }
  const reviewCount = createMemo(
    () => proposals().filter((item) => item.state === "open" || item.state === "pending").length,
  )
  const visibleProposals = createMemo(() =>
    proposals().filter((item) => item.state === "open" || item.state === "pending" || settled().has(item.proposal.id)),
  )
  const decideProposal = (item: PersonalTodoProposalView, operation: "apply" | "reject") =>
    sendProposal({ operation, proposalID: item.proposal.id, digest: item.proposal.digest })
  const retryProposal = (item: PersonalTodoProposalView) => {
    const intent = proposalRecovery()[item.proposal.id]
    if (intent) sendProposal(intent)
    if (!intent && item.state === "pending") decideProposal(item, "apply")
  }
  const compose = (next: { title?: string; reminder?: string }) => {
    const title = next.title ?? draft()
    const value = next.reminder ?? reminder()
    if (next.title !== undefined) setDraft(next.title)
    if (next.reminder !== undefined) setReminder(next.reminder)
    const intent = recovery()
    if (intent?.operation !== "create") return
    const reminderAt = value ? new Date(value).getTime() : undefined
    setRecovery({ operation: "create", title: title.trim(), reminderAt })
  }
  const begin = (item: PersonalTodoItem) => {
    setConfirming()
    setEditError()
    setEditing({
      todoID: item.id,
      title: item.title,
      detail: item.detail ?? "",
      due: local(item.dueAt),
      reminder: local(item.reminderAt),
    })
  }
  const change = (next: Partial<Edit>) => {
    const current = editing()
    if (!current) return
    const edit = { ...current, ...next }
    setEditing(edit)
    const intent = recovery()
    if (intent?.operation !== "update" || intent.todoID !== edit.todoID || intent.changes.done !== undefined) return
    const stamp = edit.due ? new Date(edit.due).getTime() : null
    const reminderAt = edit.reminder ? new Date(edit.reminder).getTime() : null
    setRecovery({
      operation: "update",
      todoID: edit.todoID,
      changes: {
        title: edit.title.trim(),
        detail: edit.detail || null,
        dueAt: Number.isFinite(stamp) ? stamp : null,
        reminderAt: Number.isFinite(reminderAt) ? reminderAt : null,
      },
    })
  }
  const cancel = () => {
    const current = editing()
    const intent = recovery()
    if (
      current &&
      intent?.operation === "update" &&
      intent.todoID === current.todoID &&
      intent.changes.done === undefined
    ) {
      setRecovery()
      setNotice()
    }
    setEditing()
    setEditError()
  }
  const save = () => {
    const edit = editing()
    if (!edit) return
    const title = edit.title.trim()
    if (!title) return setEditError("Add a title before saving.")
    const stamp = edit.due ? new Date(edit.due).getTime() : null
    if (stamp !== null && !Number.isFinite(stamp)) return setEditError("Use a valid due date and time.")
    const reminderAt = edit.reminder ? new Date(edit.reminder).getTime() : null
    if (reminderAt !== null && !Number.isFinite(reminderAt)) return setEditError("Use a valid reminder date and time.")
    setEditError()
    send({
      operation: "update",
      todoID: edit.todoID,
      changes: { title, detail: edit.detail || null, dueAt: stamp, reminderAt },
    })
  }
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
  const progress = createMemo(() =>
    Math.max(0, Math.min(100, (1 - remainingMs() / (timer()?.durationMs || duration().value)) * 100)),
  )
  const timerLabel = createMemo(() => {
    const state = timer()?.state
    if (state === "running") return "Focusing"
    if (state === "paused") return "Paused"
    if (state === "completed") return "Focus complete"
    return "Ready when you are"
  })
  const focusCopy = createMemo(() => (timer()?.state === "running" ? "Stay with it" : "Your next focus session"))
  const durationCopy = createMemo(
    () => `${Math.round((timer()?.durationMs || duration().value) / 60_000)} minute session`,
  )
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
          <span class="todo-kicker">Make room for focus</span>
          <h2 id="focus-timer-title">Focus timer</h2>
        </div>
        <span data-slot="focus-timer-state">{timerLoading() ? "Checking your timer…" : timerLabel()}</span>
      </div>
      <div data-slot="focus-timer-dial" style={{ "--focus-progress": `${progress()}%` }}>
        <div data-slot="focus-timer-face">
          <span>{focusCopy()}</span>
          <output aria-label="Focus time remaining" aria-live="off">
            {timerLoading() ? "--:--" : clock()}
          </output>
          <span>{durationCopy()}</span>
        </div>
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
          <p>
            A calmer way to make progress · <span>{remaining()} open</span>
          </p>
        </div>
      </header>

      <section data-slot="todo-overview" aria-label="Todo views">
        <div data-slot="todo-overview-heading">
          <span class="todo-kicker">Your day at a glance</span>
          <h2>Where to begin</h2>
          <p>Raya brings the timely and important work forward.</p>
        </div>
        <div data-slot="todo-overview-grid">
          <For
            each={
              [
                { id: "all", label: "All tasks", count: () => items().length, glyph: "◫" },
                { id: "today", label: "Today", count: today, glyph: "▣" },
                { id: "important", label: "Important", count: important, glyph: "✦" },
                { id: "scheduled", label: "Scheduled", count: scheduled, glyph: "◷" },
                { id: "done", label: "Completed", count: done, glyph: "✓" },
              ] as const
            }
          >
            {(view) => (
              <button
                type="button"
                data-active={filter() === view.id}
                aria-pressed={filter() === view.id}
                onClick={() => setFilter(view.id)}
              >
                <span aria-hidden="true">{view.glyph}</span>
                <strong>{view.count()}</strong>
                <small>{view.label}</small>
              </button>
            )}
          </For>
        </div>
      </section>

      {panel()}

      <section data-slot="todo-assistant" aria-labelledby="todo-assistant-title">
        <div>
          <span class="todo-kicker">Plan with Raya</span>
          <h2 id="todo-assistant-title">Tell Raya what you want to do</h2>
          <p>She can turn a goal into a reviewed plan with next steps, priorities and reminders.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            plan(askDraft())
          }}
        >
          <label class="sr-only" for="todo-assistant-input">
            Ask Raya to plan a todo
          </label>
          <input
            id="todo-assistant-input"
            value={askDraft()}
            onInput={(event) => setAskDraft(event.currentTarget.value)}
            placeholder="I want to learn how to play the violin…"
          />
          <Button type="submit" disabled={!askDraft().trim() || !props.onAskRaya}>
            Ask Raya
          </Button>
        </form>
        <div data-slot="todo-assistant-prompts">
          <button type="button" onClick={() => plan("I want to learn how to play the violin")}>
            Plan a new goal
          </button>
          <button type="button" onClick={() => plan("Help me prioritize my open todos for today")}>
            Help me prioritize
          </button>
          <button type="button" onClick={() => plan("Suggest useful reminders for my upcoming todos")}>
            Set smart reminders
          </button>
        </div>
      </section>

      <section data-slot="todo-proposals" aria-labelledby="todo-proposals-title">
        <header data-slot="todo-proposals-header">
          <div>
            <h2 id="todo-proposals-title">For review</h2>
            <p>{reviewCount()} waiting</p>
          </div>
          <Button
            variant="ghost"
            size="small"
            disabled={proposalLoading()}
            onClick={() => sendProposal({ operation: "list" })}
          >
            Refresh
          </Button>
        </header>

        <Show when={proposalNotice()}>
          {(notice) => (
            <div data-slot="todo-proposals-notice" data-kind={notice().kind} role="alert">
              <span>{notice().message}</span>
              <Button variant="ghost" size="small" onClick={() => sendProposal({ operation: "list" })}>
                Try again
              </Button>
            </div>
          )}
        </Show>

        <Show when={proposalLoading()}>
          <div data-slot="todo-proposals-loading" role="status">
            <Spinner /> <span>Checking plans…</span>
          </div>
        </Show>

        <Show when={!proposalLoading() && !proposalNotice() && visibleProposals().length === 0}>
          <p data-slot="todo-proposals-empty">No plans are waiting for review.</p>
        </Show>

        <Show when={!proposalLoading() && visibleProposals().length > 0}>
          <ul data-slot="todo-proposals-list" aria-label="Todo plans for review">
            <For each={visibleProposals()}>
              {(item) => {
                const id = () => item.proposal.id
                const issue = () => proposalIssues()[id()]
                const recovery = () => proposalRecovery()[id()]
                return (
                  <li data-proposal-id={id()}>
                    <TodoProposalCard
                      proposal={proposal(item)}
                      state={item.state}
                      busy={proposalBusy()[id()]}
                      issue={issue()}
                      decisionDisabled={issue() !== undefined}
                      onApply={() => decideProposal(item, "apply")}
                      onEdit={() => props.onEditProposal?.(id())}
                      onReject={() => decideProposal(item, "reject")}
                      onRetry={recovery() || item.state === "pending" ? () => retryProposal(item) : undefined}
                    />
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </section>

      <form
        data-slot="personal-todo-compose"
        onSubmit={(event) => {
          event.preventDefault()
          const title = draft().trim()
          const stamp = reminder() ? new Date(reminder()).getTime() : undefined
          if (title && (stamp === undefined || Number.isFinite(stamp)))
            send({ operation: "create", title, reminderAt: stamp })
        }}
      >
        <div data-slot="personal-todo-compose-heading">
          <span class="todo-kicker">One clear next step</span>
          <h2>Add a task</h2>
        </div>
        <TextField
          value={draft()}
          onChange={(title) => compose({ title })}
          aria-label="New todo"
          placeholder="What needs your attention?"
          maxLength={500}
          disabled={pending().create === true}
        />
        <TextField
          label="Reminder date and time"
          type="datetime-local"
          value={reminder()}
          onChange={(value) => compose({ reminder: value })}
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
        <div data-slot="todo-list-heading">
          <div>
            <span class="todo-kicker">Your tasks</span>
            <h2>
              {filter() === "all"
                ? "What’s next"
                : filter() === "done"
                  ? "Completed"
                  : filter() === "today"
                    ? "Today"
                    : filter() === "important"
                      ? "Important"
                      : "Scheduled"}
            </h2>
          </div>
          <span>{visible().length} shown</span>
        </div>
        <ul data-slot="personal-todo-list" aria-label="Personal todos">
          <For each={visible()}>
            {(item) => (
              <li data-slot="personal-todo-item" data-done={item.done}>
                <Checkbox
                  hideLabel
                  checked={item.done}
                  disabled={pending()[item.id] === true}
                  onChange={(done) => send({ operation: "update", todoID: item.id, changes: { done } })}
                >
                  {item.done ? `Reopen ${item.title}` : `Complete ${item.title}`}
                </Checkbox>
                <Show
                  when={editing()?.todoID === item.id ? editing() : undefined}
                  fallback={
                    <>
                      <div data-slot="personal-todo-content">
                        <span>{item.title}</span>
                        <Show when={item.priority === "urgent" || item.priority === "high"}>
                          <small data-slot="todo-priority">{item.priority === "urgent" ? "Urgent" : "Important"}</small>
                        </Show>
                        <Show when={item.detail}>
                          <p>{item.detail}</p>
                        </Show>
                        <Show when={item.dueAt !== undefined}>
                          <time
                            dateTime={new Date(item.dueAt ?? 0).toISOString()}
                            data-overdue={!item.done && (item.dueAt ?? 0) < Date.now()}
                          >
                            Due {due(item.dueAt ?? 0)}
                          </time>
                        </Show>
                        <Show when={item.reminderAt !== undefined}>
                          <time
                            dateTime={new Date(item.reminderAt ?? 0).toISOString()}
                            data-slot="personal-todo-reminder"
                          >
                            Reminder {due(item.reminderAt ?? 0)}
                          </time>
                        </Show>
                        <Show when={item.subtasks?.length}>
                          <div data-slot="todo-subtasks">
                            <For each={item.subtasks}>
                              {(child) => (
                                <span data-done={child.done}>
                                  {child.done ? "✓" : "○"} {child.title}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                        <button
                          type="button"
                          data-slot="todo-expand"
                          onClick={() => plan(`Expand this existing Todo into practical next steps: ${item.title}`)}
                        >
                          Ask Raya to expand
                        </button>
                      </div>
                      <Show
                        when={confirming() === item.id}
                        fallback={
                          <div data-slot="personal-todo-actions">
                            <IconButton
                              icon="edit"
                              variant="ghost"
                              size="small"
                              aria-label={`Edit ${item.title}`}
                              disabled={pending()[item.id] === true}
                              onClick={() => begin(item)}
                            />
                            <IconButton
                              icon="trash"
                              variant="ghost"
                              size="small"
                              aria-label={`Delete ${item.title}`}
                              disabled={pending()[item.id] === true}
                              onClick={() => setConfirming(item.id)}
                            />
                          </div>
                        }
                      >
                        <div
                          data-slot="personal-todo-confirm"
                          role="group"
                          aria-label={`Confirm deleting ${item.title}`}
                        >
                          <Button intent="quiet" scale="compact" onClick={() => setConfirming()}>
                            Cancel
                          </Button>
                          <Button
                            intent="destructive"
                            scale="compact"
                            pending={pending()[item.id] === true}
                            onClick={() => send({ operation: "delete", todoID: item.id })}
                          >
                            Delete
                          </Button>
                        </div>
                      </Show>
                    </>
                  }
                >
                  {(edit) => (
                    <form
                      data-slot="personal-todo-edit"
                      aria-label={`Edit ${item.title}`}
                      onSubmit={(event) => {
                        event.preventDefault()
                        save()
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape" || pending()[item.id]) return
                        event.preventDefault()
                        cancel()
                      }}
                    >
                      <TextField
                        label="Title"
                        value={edit().title}
                        onChange={(title) => change({ title })}
                        maxLength={500}
                        required
                        autofocus
                        disabled={pending()[item.id] === true}
                        error={editError()}
                      />
                      <TextField
                        label="Details"
                        value={edit().detail}
                        onChange={(detail) => change({ detail })}
                        maxLength={10_000}
                        multiline
                        rows={3}
                        placeholder="Add context or the next step"
                        disabled={pending()[item.id] === true}
                      />
                      <TextField
                        label="Due date and time"
                        type="datetime-local"
                        value={edit().due}
                        onChange={(value) => change({ due: value })}
                        disabled={pending()[item.id] === true}
                      />
                      <TextField
                        label="Reminder date and time"
                        type="datetime-local"
                        value={edit().reminder}
                        onChange={(value) => change({ reminder: value })}
                        disabled={pending()[item.id] === true}
                      />
                      <div data-slot="personal-todo-edit-actions">
                        <span>Escape cancels</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          disabled={pending()[item.id]}
                          onClick={cancel}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" size="small" disabled={pending()[item.id] || !edit().title.trim()}>
                          Save
                        </Button>
                      </div>
                    </form>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </main>
  )
}
