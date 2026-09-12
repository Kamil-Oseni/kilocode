import { Component, For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Select } from "@kilocode/kilo-ui/select"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { PresenceBadge } from "../chat/PresenceBadge"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { runPresence } from "../../utils/run-presence"
import type { AgentInfo, ExtensionMessage } from "../../types/messages"
import { action, reason, select, type Execution } from "./run"
import { compile, initial, populate } from "../../../../src/shared/routine-schedule"
import { ScheduleEditor } from "./ScheduleEditor"
import { RunReview } from "./RunReview"
import { Archive } from "./Archive"
import { AccessReview } from "./AccessReview"
import { OutputEditor } from "./OutputEditor"
import { OutputReview } from "./OutputReview"
import { Inbox, status, type Box } from "./Inbox"
import { Output } from "../../../../src/shared/routine-output"

type Schedule =
  | { kind: "once"; at: number }
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "event"; source: string; filter?: string }
  | { kind: "manual" }

type Agent = {
  id: string
  name: string
  role: string
  objective: string
  output?: Output
  capabilities: string[]
  schedule: Schedule
  scheduleVersion?: number
  enabled: boolean
  note?: string
  nextRun?: number
  execution?: Execution
  access?: "full" | "brief"
  dir?: string
  mode?: string
  plan?: string
}

type Run = {
  id: string
  agentID: string
  at: number
  trigger?: import("@kilocode/sdk/v2/client").KilocodeRoutineRunsResponse[number]["trigger"]
  sessionID: string
  status: "running" | "complete" | "blocked" | "error"
  blockedReason?: string
  outcome?: import("@kilocode/sdk/v2/client").KilocodeRoutineRunsResponse[number]["outcome"]
}

type Template = {
  id: string
  name: string
  role: string
  objective: string
  capabilities: string[]
  schedule: Schedule
}

type Choice = { key: string; label: string }

const roles = [
  { id: "briefer", label: "Briefer" },
  { id: "reviewer", label: "Reviewer" },
  { id: "accountant", label: "Accountant" },
  { id: "inbox", label: "Inbox" },
  { id: "designer", label: "Designer" },
  { id: "coder", label: "Coder" },
  { id: "generalist", label: "Generalist" },
  { id: "custom", label: "Custom" },
] as const

const chat: Choice = { key: "chat", label: "Same as chat" }

const work = [
  {
    id: "full" as const,
    label: "Full tool access",
    description:
      "Allows editing, shell commands, browser actions, delegation, and external tools unless a saved tool list restricts them. This is not limited to workspace files.",
  },
  {
    id: "brief" as const,
    label: "Read and report",
    description:
      "Read files and resources, search their contents, and report in the run conversation. Shell, browser actions, delegation, and unlisted tool permissions are denied.",
  },
]

function title(agent: AgentInfo) {
  if (agent.displayName) return agent.displayName
  return agent.name
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function whenLabel(schedule: NonNullable<Extract<ExtensionMessage, { type: "routineForecast" }>["schedule"]>) {
  if (schedule.kind === "manual") return "When you ask"
  if (schedule.kind === "once") return new Date(Number(schedule.at)).toLocaleString()
  if (schedule.kind === "event") return `On ${schedule.source}${schedule.filter ? ` (${schedule.filter})` : ""}`
  if (schedule.expr === "0 18 * * 1-5") return "Weekdays at 6pm"
  if (schedule.expr === "0 9 * * 1-5") return "Weekday mornings"
  if (schedule.expr === "0 9 * * *") return "Every morning"
  return schedule.expr
}

function timezone(schedule: NonNullable<Extract<ExtensionMessage, { type: "routineForecast" }>["schedule"]>) {
  return schedule.kind === "cron" ? schedule.tz : undefined
}

function latest(item: Agent, book: Record<string, Run[]>) {
  if (item.execution) return (book[item.id] ?? []).findLast((run) => run.sessionID === item.execution?.sessionID)
  return select(book[item.id] ?? [])
}

function held(item: Agent, book: Record<string, Run[]>) {
  const run = latest(item, book)
  if (!run) return
  if (run.status === "running" || (run.status === "blocked" && run.blockedReason === "waiting on you")) return run.id
}

function live(item: Agent, book: Record<string, Run[]>) {
  const state = item.execution?.state
  return !!held(item, book) || state === "active" || state === "starting"
}

function advice(item: Agent, book: Record<string, Run[]>) {
  if (live(item, book)) {
    return item.enabled
      ? "Existing runs continue. The new schedule applies after unfinished work settles."
      : "Existing runs continue. The new schedule applies after unfinished work settles. This worker stays paused."
  }
  if (item.enabled) return "Existing runs continue. The new schedule applies after unfinished work settles."
  return "This routine is paused. Saving keeps it paused."
}

function roleof(role: string, custom: string) {
  return role === "custom" ? custom.trim() || "custom" : role
}

function grants(money: boolean, messages: boolean) {
  return [money ? "money" : "", messages ? "messages" : ""].filter(Boolean)
}

function known(id: string) {
  return roles.some((item) => item.id === id && item.id !== "custom")
}

function folder(path: string) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean)
  return parts.at(-1) ?? path
}

function others(id: string, roster: Agent[]) {
  return roster.filter((item) => item.id !== id)
}

function heading(editing: boolean, screen: "roster" | "assign") {
  if (editing) return "Edit schedule"
  if (screen === "assign") return "Assign a routine"
  return "Routines"
}

function tone(on: boolean) {
  return on ? "primary" : "ghost"
}

function caption(command: ReturnType<typeof action>, item: Agent) {
  if (command === "review") return "Needs review"
  if (command === "running") return item.execution?.state === "starting" ? "Starting" : "Running"
  if (command === "open") return item.execution?.state === "recovery" ? "Review run" : "Open run"
  return "Run now"
}

function flag(on: boolean) {
  return on ? "true" : undefined
}

function occupancy(item: Agent, box?: Box) {
  return status(box?.state ?? (item.enabled ? "scheduled" : "paused"))
}

function unzoned(item: Agent) {
  return item.schedule.kind === "cron" && !item.schedule.tz?.trim()
}

function blocked(command: ReturnType<typeof action>, access: Agent["access"], canOpen: boolean) {
  if (command === "running" || command === "review") return true
  if (command === "open") return !canOpen
  return access === undefined
}

const Person: Component<{
  item: Agent
  run?: Run
  box?: Box
  stale?: string
  busy: boolean
  live: boolean
  picked: boolean
  current: boolean
  panel: string
  inspectable: boolean
  inspected: boolean
  canOpen: boolean
  presence: ReturnType<typeof runPresence>
  command: ReturnType<typeof action>
  onChoose: () => void
  onMark: (on: boolean) => void
  onOpen: () => void
  onAct: () => void
  onToggle: () => void
  onEdit: () => void
  onAccess: () => void
  onOutput: () => void
  onInspect: () => void
  onRemove: () => void
}> = (props) => {
  const resume = () => (!props.item.enabled ? `${props.panel}-${props.item.id}-resume` : undefined)
  const hold = () => (props.item.enabled && props.live ? `${props.panel}-${props.item.id}-hold` : undefined)
  return (
    <li
      class="routines-row"
      data-presence={props.presence}
      data-paused={flag(!props.item.enabled)}
      data-picked={flag(props.picked)}
      data-current={flag(props.current)}
    >
      <Checkbox hideLabel checked={props.picked} onChange={props.onMark}>
        Select {props.item.name}
      </Checkbox>
      <button
        type="button"
        class="routines-identity"
        data-routine-worker={props.item.id}
        aria-current={flag(props.current)}
        onClick={props.onChoose}
      >
        <span class="routines-name">{props.item.name}</span>
        <span class="routines-meta">
          {props.item.role} · {occupancy(props.item, props.box)}
          <Show when={props.box?.unread}>{(n) => <> · {n()} unread</>}</Show>
        </span>
        <span class="routines-job">{props.box?.latest?.body ?? props.item.objective}</span>
        <Show when={props.stale}>
          <span class="routines-note" role="status">
            History may be stale: {props.stale}
          </span>
        </Show>
        <Show when={props.run?.outcome?.summary}>
          <span class="routines-note routines-result-summary">Recorded result: {props.run?.outcome?.summary}</span>
        </Show>
        <Show when={props.run}>{(run) => <span class="routines-note">{reason(run())}</span>}</Show>
        <Show when={props.item.execution?.state === "recovery"}>
          <span class="routines-note">Recovery review required before another run can start.</span>
        </Show>
        <Show when={props.run?.blockedReason}>
          <span class="routines-note">{props.run?.blockedReason}</span>
        </Show>
        <Show when={props.item.note}>
          <span class="routines-note">{props.item.note}</span>
        </Show>
        <Show when={unzoned(props.item)}>
          <span class="routines-note">
            Automatic runs need timezone review. Choose Edit schedule; manual runs remain available when otherwise
            permitted.
          </span>
        </Show>
      </button>
      <div class="routines-side">
        <PresenceBadge state={props.presence} onAck={props.canOpen ? props.onOpen : undefined} />
        <div class="routines-actions">
          <Button
            size="small"
            variant="ghost"
            disabled={blocked(props.command, props.item.access, props.canOpen)}
            onClick={props.onAct}
          >
            {caption(props.command, props.item)}
          </Button>
          <Button size="small" variant="ghost" aria-describedby={resume() ?? hold()} onClick={props.onToggle}>
            {props.item.enabled ? "Pause" : "Enable"}
          </Button>
          <Button size="small" variant="ghost" onClick={props.onEdit}>
            Edit schedule
          </Button>
          <Button size="small" variant="ghost" data-routine-access={props.item.id} onClick={props.onAccess}>
            Review access
          </Button>
          <Button size="small" variant="ghost" data-routine-output={props.item.id} onClick={props.onOutput}>
            Edit output
          </Button>
          <Show when={props.inspectable}>
            <Button
              size="small"
              variant="ghost"
              aria-expanded={props.inspected}
              aria-controls={props.inspected ? props.panel : undefined}
              data-routine-instructions={props.item.id}
              onClick={props.onInspect}
            >
              {props.inspected ? "Hide review" : "Review runs"}
            </Button>
          </Show>
          <IconButton
            icon="trash"
            size="small"
            variant="ghost"
            aria-label={`Remove ${props.item.name}`}
            onClick={props.onRemove}
          />
        </div>
      </div>
      <Show when={!props.item.enabled}>
        <p id={resume()} class="routines-hint routines-resume">
          Enabling allows future runs and starts a fresh consecutive-block count. Earlier runs remain in history.
          Resolve the cause of a pause before enabling again.
          <Show when={props.live}> The current run continues until it settles.</Show>
        </p>
      </Show>
      <Show when={props.item.enabled && props.live}>
        <p id={hold()} class="routines-hint">
          Pausing stops later starts. The current run continues until it settles.
        </p>
      </Show>
    </li>
  )
}

interface RoutinesViewProps {
  onBack?: () => void
  onOpenSession?: (id: string) => void
}

const RoutinesView: Component<RoutinesViewProps> = (props) => {
  const vscode = useVSCode()
  const language = useLanguage()
  const session = useSession()
  const dialog = useDialog()
  const [agents, setAgents] = createSignal<Agent[]>([])
  const [templates, setTemplates] = createSignal<Template[]>([])
  const [runs, setRuns] = createSignal<Record<string, Run[]>>({})
  const [inspection, setInspection] = createSignal<{ agentID: string; name: string; runID?: string }>()
  const [reviewed, setReviewed] = createSignal<Agent>()
  const [section, setSection] = createSignal<"access" | "output">("access")
  const panel = createUniqueId()
  let root: HTMLDivElement | undefined
  const [error, setError] = createSignal("")
  const [name, setName] = createSignal("")
  const [role, setRole] = createSignal("briefer")
  const [custom, setCustom] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const [output, setOutput] = createSignal<Output>({
    destination: "conversation",
    description: "",
    criteria: [{ id: `criterion-${crypto.randomUUID()}`, description: "", verification: "" }],
  })
  const deliverable = createMemo(() => Output.safeParse(output()).success)
  const [draft, setDraft] = createSignal(initial(Intl.DateTimeFormat().resolvedOptions().timeZone))
  const [editing, setEditing] = createSignal<Agent>()
  const [pending, setPending] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [request, setRequest] = createSignal<{ id: string; key: string }>()
  const [preview, setPreview] = createSignal<Extract<ExtensionMessage, { type: "routineForecast" }>>()
  const key = () => JSON.stringify([draft(), editing()?.id, editing()?.schedule, editing()?.scheduleVersion])
  const confirmed = () => Boolean(preview()?.forecastID) && request()?.key === key()
  const previewing = () => request()?.key === key() && !preview()
  const [money, setMoney] = createSignal(false)
  const [messages, setMessages] = createSignal(false)
  const [plan, setPlan] = createSignal("")
  const [mode, setMode] = createSignal("chat")
  const [dir, setDir] = createSignal("")
  const [wait, setWait] = createSignal("")
  const [access, setAccess] = createSignal<"full" | "brief">("brief")
  const [screen, setScreen] = createSignal<"roster" | "assign">("roster")
  const [busy, setBusy] = createSignal<Record<string, true>>({})
  const [picked, setPicked] = createSignal<Record<string, true>>({})
  const [saving, setSaving] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [freshness, setFreshness] = createSignal("Waiting to refresh routines.")
  const [stale, setStale] = createSignal<Record<string, string>>({})
  const [boxes, setBoxes] = createSignal<Record<string, Box>>({})
  const [chosen, setChosen] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const [attention, setAttention] = createSignal<"all" | "unread" | "needs">("all")
  let correlation = crypto.randomUUID()
  let revision = 0
  let dirty = false
  let hold = false

  const leave = () => {
    const id = chosen()
    setChosen()
    queueMicrotask(() => {
      if (chosen() || !root?.isConnected) return
      const title = root.querySelector<HTMLElement>(".routines-title")
      if (!id) {
        title?.focus()
        return
      }
      const token = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id
      const button = root.querySelector<HTMLElement>(`.routines-identity[data-routine-worker="${token}"]`)
      const target = button ?? title
      target?.focus()
    })
  }

  const dismiss = () => {
    const id = reviewed()?.id
    const attribute = section() === "output" ? "data-routine-output" : "data-routine-access"
    setReviewed(undefined)
    load()
    queueMicrotask(() => {
      if (reviewed() || inspection() || !root?.isConnected) return
      const button = [...(root?.querySelectorAll<HTMLButtonElement>(`[${attribute}]`) ?? [])].find(
        (item) => item.getAttribute(attribute) === id,
      )
      const target = button ?? root?.querySelector<HTMLElement>(".routines-title")
      target?.focus()
    })
  }

  const inspected = (id: string) => inspection()?.agentID === id
  const close = () => {
    const id = inspection()?.agentID
    setInspection(undefined)
    queueMicrotask(() => {
      if (inspection() || reviewed() || !root?.isConnected) return
      const button = [...root.querySelectorAll<HTMLButtonElement>("[data-routine-instructions]")].find(
        (item) => item.dataset.routineInstructions === id,
      )
      const target = button ?? root.querySelector<HTMLElement>(".routines-title")
      target?.focus()
    })
  }
  const inspect = (item: Agent) => {
    setReviewed(undefined)
    if (inspected(item.id)) return close()
    setInspection({ agentID: item.id, name: item.name, runID: item.execution?.runID ?? latest(item, runs())?.id })
  }
  const inspectable = (item: Agent) => Boolean(item.execution?.runID || runs()[item.id]?.length)
  const review = (item: Agent, section: "access" | "output" = "access") => {
    setInspection(undefined)
    setSection(section)
    setReviewed(item)
  }
  const roster = (items: Agent[]) => {
    setLoaded(true)
    setAgents(items)
    if (reviewed() && section() !== "output" && !items.some((item) => item.id === reviewed()?.id)) dismiss()
    const id = chosen()
    if (id && !items.some((item) => item.id === id)) setChosen()
    if (items.some((item) => inspected(item.id))) return
    if (root?.querySelector(".routines-instructions")?.contains(document.activeElement)) return close()
    setInspection(undefined)
  }

  const load = () => {
    if (refreshing()) {
      dirty = true
      return
    }
    setRefreshing(true)
    setFreshness("Refreshing routines and recorded history...")
    vscode.postMessage({ type: "routineList", requestID: correlation, viewID: correlation })
  }

  onMount(() => {
    load()
    if (session.agents().length === 0) vscode.postMessage({ type: "requestAgents" })
    const tick = setInterval(() => {
      if (!hold) load()
    }, 4000)
    onCleanup(() => clearInterval(tick))
  })

  const receive = (msg: Extract<ExtensionMessage, { type: "routineForecast" }>) => {
    if (msg.requestID !== request()?.id || request()?.key !== key()) return
    setPreview(msg)
    if (msg.error) setError([msg.error, msg.recovery?.next].filter(Boolean).join(" "))
  }

  const updated = (msg: Extract<ExtensionMessage, { type: "routineScheduleUpdated" }>) => {
    if (!pending() || msg.requestID !== pending() || msg.agentID !== editing()?.id) return
    setPending("")
    hold = false
    setSaving(false)
    setPreview(undefined)
    setRequest(undefined)
    if (msg.error) {
      setNotice([msg.error, msg.recovery?.next].filter(Boolean).join(" "))
      return
    }
    setEditing(undefined)
    setScreen("roster")
    load()
  }

  const refresh = (msg: ExtensionMessage) => {
    if (msg.type === "connectionState") {
      correlation = crypto.randomUUID()
      revision = 0
      dirty = false
      setRefreshing(false)
      if (msg.state === "connected") load()
      else setFreshness("Disconnected. Previously loaded routine information may be stale.")
    }
    if (msg.type === "workspaceDirectoryChanged") {
      correlation = crypto.randomUUID()
      revision = 0
      dirty = false
      setRefreshing(false)
      setLoaded(false)
      setAgents([])
      setRuns({})
      setStale({})
      setBoxes({})
      setChosen()
      load()
    }
    if ((msg.type === "routineState" || msg.type === "routineRuns" || msg.type === "routineInbox") && msg.refreshID !== undefined) {
      if (msg.viewID !== correlation || msg.requestID !== correlation || msg.refreshID < revision) return false
      revision = msg.refreshID
    }
    if (msg.type === "routineState" && msg.refresh) {
      setRefreshing(msg.refresh === "loading")
      if (msg.refresh === "loading") setFreshness("Refreshing routines and recorded history...")
      if (msg.refresh === "complete") setFreshness("Routines and recorded history refreshed.")
      if (msg.refresh === "partial")
        setFreshness("Some history could not be refreshed. Previous history remains visible.")
      if (msg.refresh === "error") setFreshness("Refresh failed. Previously loaded information may be stale.")
      if (msg.refresh !== "loading" && dirty && !hold) {
        dirty = false
        load()
      }
    }
    return true
  }

  const history = (msg: Extract<ExtensionMessage, { type: "routineRuns" }>) => {
    if (msg.error) setStale((prior) => ({ ...prior, [msg.agentID]: msg.error! }))
    if (Array.isArray(msg.runs)) {
      setRuns((prior) => ({ ...prior, [msg.agentID]: msg.runs as Run[] }))
      setStale((prior) => {
        const next = { ...prior }
        delete next[msg.agentID]
        return next
      })
    }
    setBusy((prior) => {
      const next = { ...prior }
      delete next[msg.agentID]
      return next
    })
  }

  const received = (msg: Extract<ExtensionMessage, { type: "routineState" }>) => {
    if (msg.error) {
      if (msg.requestID === correlation) setRefreshing(false)
      setError([msg.error, msg.recovery?.next].filter(Boolean).join(" "))
      if (!editing()) {
        hold = false
        setSaving(false)
      }
    }
    if (msg.saved && !msg.error && editing() && saving() && !pending()) {
      setError("")
      hold = false
      setSaving(false)
      setEditing(undefined)
      setScreen("roster")
      load()
    }
    if (msg.saved && !msg.error && !editing()) {
      setError("")
      hold = false
      setSaving(false)
      setScreen("roster")
      setPicked({})
    }
    if (msg.agents) {
      roster(msg.agents as Agent[])
    }
    if (msg.templates) setTemplates(msg.templates as Template[])
  }

  const boxed = (msg: Extract<ExtensionMessage, { type: "routineInbox" }>) => {
    if (msg.error) return
    if (!Array.isArray(msg.items)) return
    const next: Record<string, Box> = {}
    for (const item of msg.items as Box[]) {
      if (item?.agentID) next[item.agentID] = item
    }
    setBoxes(next)
  }

  const unsub = vscode.onMessage((msg: ExtensionMessage) => {
    if (!refresh(msg)) return
    if (msg.type === "routineForecast") receive(msg)
    if (msg.type === "routineScheduleUpdated") updated(msg)
    if (msg.type === "routineState") received(msg)
    if (msg.type === "routineInbox") boxed(msg)
    if (msg.type === "folderPickerResult" && msg.requestId === wait() && msg.path) {
      setDir(msg.path)
      setWait("")
    }
    if (msg.type === "routineRuns") history(msg)
    if ((msg.type === "sessionStatus" || msg.type === "sessionTurnClosed") && !hold) load()
  })
  onCleanup(unsub)

  const picks = createMemo<Choice[]>(() => {
    const extras = session
      .agents()
      .filter((item) => !item.hidden)
      .map((item) => ({ key: item.name, label: title(item) }))
    extras.sort((a, b) => a.label.localeCompare(b.label))
    const list = [chat, ...extras]
    const extra = editing()?.mode?.trim()
    if (extra && extra !== "chat" && !list.some((item) => item.key === extra))
      list.push({ key: extra, label: extra })
    return list
  })

  const current = createMemo(() => picks().find((item) => item.key === mode()) ?? chat)

  const pick = (next: string) => {
    setRole(next)
    setMoney(false)
    setMessages(false)
  }

  const consent = () => (role() !== "accountant" || money()) && (role() !== "inbox" || messages())

  const apply = (item: Template) => {
    setEditing(undefined)
    setScreen("assign")
    setName(item.name)
    pick(item.role)
    setObjective(item.objective)
    setOutput({
      destination: "conversation",
      description: "",
      criteria: [
        {
          id: `criterion-${crypto.randomUUID()}`,
          description: "",
          verification: "",
        },
      ],
    })
    setDraft(populate(item.schedule, draft().zone))
  }

  const moved = () => {
    const item = editing()
    if (!item) return false
    return (
      name().trim() !== item.name ||
      objective().trim() !== item.objective ||
      roleof(role(), custom()) !== item.role ||
      dir().trim() !== (item.dir ?? "") ||
      (current().key === "chat" ? undefined : current().key) !== (item.mode?.trim() || undefined) ||
      plan().trim() !== (item.plan ?? "")
    )
  }

  const caption = () => {
    if (saving()) return "Saving"
    if (!editing()) return "Confirm and assign"
    if (confirmed()) return "Confirm schedule change"
    return "Save assignment"
  }

  const blocked = () => {
    if (saving()) return true
    if (editing()) return !name().trim() || !objective().trim() || !consent() || (!confirmed() && !moved())
    return !objective().trim() || !dir().trim() || !consent() || !deliverable() || !confirmed()
  }

  const persist = (item: Agent) => {
    const named = name().trim()
    const job = objective().trim()
    const part = roleof(role(), custom())
    const dest = dir().trim()
    if (!named || !job) {
      setError("Keep a name and standing job.")
      return
    }
    if (!consent()) {
      setError("Choose whether to allow the records this role needs before assigning it.")
      return
    }
    const token = preview()?.forecastID
    const timed = confirmed() && !!token
    if (!moved() && !timed) {
      setError(
        "Preview the schedule before saving, or change the name, role, standing job, write folder, agent, or plan file.",
      )
      return
    }
    setError("")
    setSaving(true)
    hold = true
    if (moved())
      vscode.postMessage({
        type: "routineUpdate",
        agentID: item.id,
        name: named,
        objective: job,
        role: part,
        dir: dest || undefined,
        mode: current().key,
        plan: plan().trim(),
        capabilities: part === "accountant" || part === "inbox" ? grants(money(), messages()) : undefined,
      })
    if (!timed) return
    const id = crypto.randomUUID()
    setPending(id)
    setNotice("")
    vscode.postMessage({ type: "routineScheduleUpdate", requestID: id, agentID: item.id, forecastID: token })
  }

  const create = () => {
    if (!editing() && !consent()) {
      setError("Choose whether to allow the records this role needs before assigning it.")
      return
    }
    if (!editing() && !deliverable()) {
      setError("Describe the required output and how to verify each criterion before assigning it.")
      return
    }
    const item = editing()
    if (item) {
      persist(item)
      return
    }
    const token = preview()?.forecastID
    if (!confirmed() || !token) {
      setError("Preview the schedule before assigning this routine.")
      return
    }
    setError("")
    setSaving(true)
    hold = true
    const capabilities = grants(money(), messages())
    const chosen = current()
    vscode.postMessage({
      type: "routineCreate",
      name: name() || (role() === "custom" ? custom() : role()),
      role: role() === "custom" ? custom().trim() || "custom" : role(),
      objective: objective(),
      output: output(),
      forecastID: token,
      capabilities,
      plan: plan().trim() || undefined,
      access: access(),
      mode: chosen.key === "chat" ? undefined : chosen.key,
      dir: dir().trim(),
    })
  }

  const toggle = (item: Agent) =>
    vscode.postMessage({ type: "routineUpdate", agentID: item.id, enabled: !item.enabled })

  const edit = (item: Agent) => {
    setEditing(item)
    setName(item.name)
    setObjective(item.objective)
    if (known(item.role)) {
      setRole(item.role)
      setCustom("")
    } else {
      setRole("custom")
      setCustom(item.role)
    }
    setDir(item.dir ?? "")
    setMode(item.mode?.trim() || "chat")
    setPlan(item.plan ?? "")
    setMoney(item.capabilities.some((cap) => ["money", "accounting", "books"].includes(cap.toLowerCase())))
    setMessages(item.capabilities.some((cap) => cap.toLowerCase() === "messages"))
    setDraft(
      populate(
        item.schedule,
        item.schedule.kind === "cron" && !item.schedule.tz?.trim()
          ? ""
          : Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    )
    setPreview(undefined)
    setRequest(undefined)
    setNotice("")
    setError("")
    setScreen("assign")
  }

  const cancel = () => {
    setEditing(undefined)
    setNotice("")
    setScreen("roster")
    load()
  }

  const fire = (item: Agent) => {
    if (busy()[item.id]) return
    const last = latest(item, runs())
    if (action(last, false, item.execution) !== "start") return
    setBusy((prior) => ({ ...prior, [item.id]: true }))
    vscode.postMessage({ type: "routineRun", agentID: item.id })
  }

  const open = (item: Agent) => {
    const id = item.execution ? item.execution.sessionID : latest(item, runs())?.sessionID
    if (id) props.onOpenSession?.(id)
  }

  const mark = (id: string, on: boolean) => {
    setPicked((prior) => {
      const next = { ...prior }
      if (on) next[id] = true
      else delete next[id]
      return next
    })
  }

  const selected = createMemo(() => Object.keys(picked()))
  const allOn = createMemo(() => agents().length > 0 && agents().every((item) => picked()[item.id]))
  const someOn = createMemo(() => selected().length > 0 && !allOn())

  const markAll = (on: boolean) => {
    if (!on) {
      setPicked({})
      return
    }
    const next: Record<string, true> = {}
    for (const item of agents()) next[item.id] = true
    setPicked(next)
  }

  const drop = (ids: string[]) => {
    vscode.postMessage({ type: "routineRemove", agentIDs: ids })
    setPicked({})
  }

  const confirm = (ids: string[]) => {
    if (!ids.length) return
    const count = ids.length
    const title = count === 1 ? "Remove this routine?" : `Remove ${count} routines?`
    dialog.show(() => (
      <Dialog title={title} fit>
        <div class="dialog-confirm-body">
          <span>
            Removed routines stop launching work. Definitions, run history, role memory, and chats are retained. Resolve
            unfinished work first; restoration is not available.
          </span>
          <div class="dialog-confirm-actions">
            <Button variant="secondary" size="large" onClick={() => dialog.close()} autofocus>
              Keep
            </Button>
            <Button
              variant="destructive"
              size="large"
              onClick={() => {
                drop(ids)
                dialog.close()
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  const state = (item: Agent) => {
    if (item.execution) return item.execution.state === "recovery" ? ("error" as const) : ("working" as const)
    const last = latest(item, runs())
    return runPresence({
      busy: last?.status === "running" || !!busy()[item.id],
      waiting: last?.status === "blocked",
      done: last?.status === "complete",
      error: last?.status === "error",
    })
  }

  const empty = createMemo(() => agents().length === 0)
  const vacant = createMemo(() => empty() && loaded())
  const shown = createMemo(() => {
    const text = query().trim().toLowerCase()
    const filter = attention()
    return agents().filter((item) => {
      const box = boxes()[item.id]
      if (filter === "unread" && !(box?.unread)) return false
      if (filter === "needs" && box?.state !== "needs_input" && box?.state !== "failed" && box?.state !== "waiting")
        return false
      if (!text) return true
      const hay = `${item.name} ${item.role} ${item.objective} ${box?.latest?.body ?? ""}`.toLowerCase()
      return hay.includes(text)
    })
  })
  const worker = createMemo(() => agents().find((item) => item.id === chosen()))
  const roleOpt = createMemo(() => roles.find((item) => item.id === role()) ?? roles[0])
  const workOpt = createMemo(() => work.find((item) => item.id === access()) ?? work[0])

  return (
    <div ref={root} class="routines-view history-view">
      <div class="history-view-header">
        <Show when={props.onBack}>
          <Button variant="ghost" size="small" icon="arrow-left" onClick={props.onBack}>
            {language.t("common.goBack")}
          </Button>
        </Show>
        <Show when={screen() === "roster" && !empty()}>
          <Checkbox hideLabel checked={allOn()} indeterminate={someOn()} onChange={markAll}>
            Select all
          </Checkbox>
        </Show>
        <h2 class="routines-title" tabIndex={-1}>
          {heading(!!editing(), screen())}
        </h2>
        <Show when={screen() === "roster" && selected().length > 0}>
          <Button class="routines-header-action" size="small" onClick={() => confirm(selected())}>
            Remove {selected().length}
          </Button>
        </Show>
        <Show when={screen() === "roster" && selected().length === 0}>
          <Button class="routines-header-action" variant="ghost" size="small" onClick={() => setScreen("assign")}>
            Assign
          </Button>
        </Show>
        <Show when={screen() === "assign"}>
          <Button class="routines-header-action" variant="ghost" size="small" disabled={saving()} onClick={cancel}>
            Done
          </Button>
        </Show>
      </div>
      <div class="routines-body" data-pane={screen() === "roster" ? "inbox" : undefined}>
        <Show when={error()}>
          <p class="routines-error" role="alert">
            {error()}
            <Button variant="ghost" size="small" onClick={() => setError("")}>
              Dismiss message
            </Button>
          </p>
        </Show>
        <Show when={screen() === "roster"}>
          <div role="status" aria-live="polite" aria-busy={refreshing()}>
            {freshness()}
            <Button variant="ghost" size="small" disabled={refreshing()} onClick={load}>
              Refresh routines
            </Button>
          </div>
          <Archive onOpenSession={props.onOpenSession} />
          <Show when={vacant()}>
            <div class="routines-empty-block">
              <p class="routines-empty">No standing jobs yet. Assign one and it will sleep until it is time to work.</p>
              <Button onClick={() => setScreen("assign")}>Assign a routine</Button>
            </div>
          </Show>
          <Show when={!vacant()}>
            <div class="routines-toolbar">
              <label class="routines-field">
                Search workers
                <input
                  value={query()}
                  placeholder="Name, role, or message"
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
              <div class="routines-filters" role="group" aria-label="Inbox filters">
                <Button size="small" variant={tone(attention() === "all")} onClick={() => setAttention("all")}>
                  All
                </Button>
                <Button
                  size="small"
                  variant={tone(attention() === "unread")}
                  onClick={() => setAttention("unread")}
                >
                  Unread
                </Button>
                <Button size="small" variant={tone(attention() === "needs")} onClick={() => setAttention("needs")}>
                  Needs attention
                </Button>
              </div>
            </div>
          </Show>
          <div class="routines-inbox" data-open={chosen() ? "true" : undefined}>
            <div class="routines-people">
          <ul class="routines-list">
            <For each={shown()}>
              {(item) => {
                const run = () => latest(item, runs())
                const command = () => action(run(), !!busy()[item.id], item.execution)
                return (
                  <Person
                    item={item}
                    run={run()}
                    box={boxes()[item.id]}
                    stale={stale()[item.id]}
                    busy={!!busy()[item.id]}
                    live={live(item, runs())}
                    picked={!!picked()[item.id]}
                    current={chosen() === item.id}
                    panel={panel}
                    inspectable={inspectable(item)}
                    inspected={inspected(item.id)}
                    canOpen={!!(item.execution ? item.execution.sessionID : run()?.sessionID) && !!props.onOpenSession}
                    presence={state(item)}
                    command={command()}
                    onChoose={() => setChosen(item.id)}
                    onMark={(value) => mark(item.id, value)}
                    onOpen={() => open(item)}
                    onAct={() => (command() === "open" ? open(item) : fire(item))}
                    onToggle={() => toggle(item)}
                    onEdit={() => edit(item)}
                    onAccess={() => review(item)}
                    onOutput={() => review(item, "output")}
                    onInspect={() => inspect(item)}
                    onRemove={() => confirm([item.id])}
                  />
                )
              }}
            </For>
          </ul>
            </div>
            <Show when={worker()} keyed>
              {(item) => (
                <Inbox
                  agentID={item.id}
                  name={item.name}
                  role={item.role}
                  box={boxes()[item.id]}
                  workspace={item.dir ? folder(item.dir) : undefined}
                  workers={others(item.id, agents())}
                  runID={held(item, runs())}
                  onBack={leave}
                />
              )}
            </Show>
            <Show when={!worker()}>
              <p class="routines-empty routines-thread">Select a worker to read reports and follow up in this conversation.</p>
            </Show>
          </div>
          <Show when={reviewed()} keyed>
            {(item) => (
              <Show when={section() === "output"} fallback={<AccessReview item={item} onClose={dismiss} />}>
                <OutputReview item={item} onClose={dismiss} />
              </Show>
            )}
          </Show>
          <Show when={inspection()} keyed>
            {(item) => (
              <RunReview
                id={panel}
                name={item.name}
                onClose={close}
                onOpenSession={props.onOpenSession}
                agentID={item.agentID}
                selected={item.runID}
                runs={runs()[item.agentID] ?? []}
              />
            )}
          </Show>
        </Show>
        <Show when={screen() === "assign"}>
          <Show when={editing()}>
            {(item) => (
              <div class="routines-field">
                <strong>{item().name}</strong>
                <span>Current schedule: {whenLabel(item().schedule)}</span>
                <span>{advice(item(), runs())}</span>
                <Show when={item().schedule.kind === "cron" && !timezone(item().schedule)?.trim()}>
                  <p role="note">
                    This routine has no saved timezone. Automatic runs are held until you choose the intended timezone
                    and check the preview before saving. Earlier run records are preserved.
                  </p>
                </Show>
              </div>
            )}
          </Show>
          <Show when={notice()}>
            {(message) => (
              <div role="alert">
                <p>{message()}</p>
                <Button variant="secondary" onClick={cancel}>
                  Back to routines to reload
                </Button>
              </div>
            )}
          </Show>
          <Show when={!editing()}>
            <p class="routines-lede">Name the job in a sentence, then say when it should wake.</p>
            <div class="routines-suggest" role="list">
              <For each={templates()}>
                {(item) => (
                  <button type="button" class="routines-suggest-btn" onClick={() => apply(item)}>
                    {item.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <form
            class="routines-form"
            onSubmit={(event) => {
              event.preventDefault()
              create()
            }}
          >
            <label class="routines-field">
              Name
              <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="Nightly review" />
            </label>
            <div class="routines-field">
              <span>Role</span>
              <Select
                options={[...roles]}
                current={roleOpt()}
                label={(item) => item.label}
                value={(item) => item.id}
                onSelect={(item) => item && pick(item.id)}
                variant="secondary"
                size="small"
              />
            </div>
            <Show when={role() === "custom"}>
              <label class="routines-field">
                Custom role
                <input
                  value={custom()}
                  onInput={(e) => setCustom(e.currentTarget.value)}
                  placeholder="ops, researcher, gardener"
                />
              </label>
            </Show>
            <label class="routines-field">
              Standing job
              <textarea
                value={objective()}
                onInput={(e) => setObjective(e.currentTarget.value)}
                placeholder="Review the repo for bugs every weekday evening."
                rows={3}
              />
            </label>
            <Show when={editing()}>
              <p class="routines-hint">
                Earlier reports stay in this conversation. This does not start a new worker. Role, write folder,
                agent, and plan file changes apply to later runs.
              </p>
            </Show>
            <ScheduleEditor value={draft()} onChange={setDraft} disabled={saving()} />
            <Show when={!editing()}>
              <OutputEditor value={output()} onChange={setOutput} disabled={saving()} />
            </Show>
            <Button
              type="button"
              variant="secondary"
              disabled={saving()}
              onClick={() => {
                const id = crypto.randomUUID()
                setError("")
                setPreview(undefined)
                setRequest({ id, key: key() })
                try {
                  const item = editing()
                  vscode.postMessage({
                    type: "routineForecast",
                    requestID: id,
                    schedule: compile(draft()),
                    edit: item
                      ? {
                          agentID: item.id,
                          expectedSchedule: item.schedule,
                          expectedScheduleVersion: item.scheduleVersion ?? 1,
                        }
                      : undefined,
                  })
                } catch (err) {
                  setPreview({
                    type: "routineForecast",
                    requestID: id,
                    error: err instanceof Error ? err.message : "Choose a valid schedule.",
                  })
                }
              }}
            >
              {previewing() ? "Checking schedule — click to retry" : "Preview schedule"}
            </Button>
            <Show when={request()?.key === key() && preview()?.error}>
              {(message) => <p role="alert">{message()}</p>}
            </Show>
            <Show when={confirmed() && preview()?.schedule}>
              {(schedule) => (
                <div class="routines-field" role="status" aria-live="polite">
                  <strong>Schedule to confirm</strong>
                  <span>{schedule().kind === "once" ? "Once at the time below" : whenLabel(schedule())}</span>
                  <Show when={preview()?.timezone ?? timezone(schedule())}>
                    <span>Timezone: {preview()?.timezone ?? timezone(schedule())}</span>
                  </Show>
                  <Show when={schedule().kind === "cron"}>
                    <span>Next three scheduled times:</span>
                    <span class="routines-hint">
                      Recurring work not already queued is skipped once it is a minute late. Queued runs remain
                      available for recovery; one-time schedules stay due until resolved.
                    </span>
                    <span class="routines-hint">
                      Skipped local times do not run; repeated local times can produce two occurrences.
                    </span>
                  </Show>
                  <For each={preview()?.occurrences ?? []}>
                    {(at) => (
                      <span>
                        {new Date(Number(at)).toLocaleString(undefined, {
                          timeZone: preview()?.timezone ?? timezone(schedule()),
                          timeZoneName: "short",
                        })}
                      </span>
                    )}
                  </For>
                  <span class="routines-hint">
                    Confirmation saves this schedule. Scheduled times require Raya's backend to be running; an
                    unfinished run can delay or prevent another start.
                  </span>
                </div>
              )}
            </Show>
            <div class="routines-field">
              <span>Agent</span>
              <Select
                options={picks()}
                current={current()}
                label={(item) => item.label}
                value={(item) => item.key}
                onSelect={(item) => item && setMode(item.key)}
                variant="secondary"
                size="small"
              />
              <p class="routines-hint">
                Same as chat, or a mode from Settings. It uses the model you assigned that mode.
                <button
                  type="button"
                  class="routines-inline"
                  onClick={() => vscode.postMessage({ type: "openSettingsPanel", tab: "agentBehaviour" })}
                >
                  Open Settings
                </button>
              </p>
            </div>
            <Show when={!editing()}>
              <div class="routines-field">
                <span>Tool access</span>
                <Select
                  options={work}
                  current={workOpt()}
                  label={(item) => item.label}
                  value={(item) => item.id}
                  onSelect={(item) => item && setAccess(item.id)}
                  variant="secondary"
                  size="small"
                />
                <p class="routines-hint">
                  {workOpt().description} This policy does not provide operating-system confinement.
                </p>
              </div>
            </Show>
            <Show when={role() === "accountant"}>
              <div class="routines-consent">
                <Checkbox checked={money()} onChange={setMoney}>
                  Allow money records
                </Checkbox>
                <p class="routines-hint">Receipts, ledgers, and invoices. It will not send payments.</p>
              </div>
            </Show>
            <Show when={role() === "inbox"}>
              <div class="routines-consent">
                <Checkbox checked={messages()} onChange={setMessages}>
                  Allow messages
                </Checkbox>
                <p class="routines-hint">Read the inbox and draft replies. It will not send unless you ask.</p>
              </div>
            </Show>
            <div class="routines-field">
              <span>Write folder</span>
              <div class="routines-pick">
                <input
                  value={dir()}
                  onInput={(e) => setDir(e.currentTarget.value)}
                  placeholder="Choose or type a folder"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    const id = crypto.randomUUID()
                    setWait(id)
                    vscode.postMessage({ type: "requestFolderPicker", requestId: id })
                  }}
                >
                  Choose
                </Button>
              </div>
              <p class="routines-hint">It can read from anywhere. New files go in this folder.</p>
            </div>
            <label class="routines-field">
              Plan file
              <input
                value={plan()}
                onInput={(e) => setPlan(e.currentTarget.value)}
                placeholder="Optional path to a .md plan"
              />
            </label>
            <Button type="submit" disabled={blocked()}>
              {caption()}
            </Button>
          </form>
        </Show>
      </div>
    </div>
  )
}

export default RoutinesView
