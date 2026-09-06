import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
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
  capabilities: string[]
  schedule: Schedule
  enabled: boolean
  note?: string
  nextRun?: number
  access?: "full" | "brief"
}

type Run = {
  id: string
  agentID: string
  at: number
  sessionID: string
  status: "running" | "complete" | "blocked" | "error"
  blockedReason?: string
  outcome?: { kind: string; summary: string; cost: number }
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
  { id: "full" as const, label: "Can edit the workspace" },
  { id: "brief" as const, label: "Read and notify only" },
]

function title(agent: AgentInfo) {
  if (agent.displayName) return agent.displayName
  return agent.name
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function whenLabel(schedule: Schedule) {
  if (schedule.kind === "manual") return "When you ask"
  if (schedule.kind === "once") return new Date(schedule.at).toLocaleString()
  if (schedule.kind === "event") return `On ${schedule.source}${schedule.filter ? ` (${schedule.filter})` : ""}`
  if (schedule.expr === "0 18 * * 1-5") return "Weekdays at 6pm"
  if (schedule.expr === "0 9 * * 1-5") return "Weekday mornings"
  if (schedule.expr === "0 9 * * *") return "Every morning"
  return schedule.expr
}

function latest(item: Agent, book: Record<string, Run[]>) {
  return (book[item.id] ?? []).at(-1)
}

function meta(item: Agent) {
  const when = item.nextRun ? `Next ${new Date(item.nextRun).toLocaleString()}` : whenLabel(item.schedule)
  const pause = item.enabled ? "" : "Paused · "
  const brief = item.access === "brief" || (!item.access && item.role === "briefer") ? " · Notify only" : ""
  return `${pause}${item.role} · ${when}${brief}`
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
  const [error, setError] = createSignal("")
  const [name, setName] = createSignal("")
  const [role, setRole] = createSignal("briefer")
  const [custom, setCustom] = createSignal("")
  const [objective, setObjective] = createSignal("")
  const [when, setWhen] = createSignal("every weekday at 6pm")
  const [money, setMoney] = createSignal(false)
  const [messages, setMessages] = createSignal(false)
  const [plan, setPlan] = createSignal("")
  const [mode, setMode] = createSignal("chat")
  const [access, setAccess] = createSignal<"full" | "brief">("brief")
  const [screen, setScreen] = createSignal<"roster" | "assign">("roster")
  const [busy, setBusy] = createSignal<Record<string, true>>({})
  const [picked, setPicked] = createSignal<Record<string, true>>({})
  const [saving, setSaving] = createSignal(false)
  let hold = false

  const load = () => vscode.postMessage({ type: "routineList" })

  onMount(() => {
    load()
    if (session.agents().length === 0) vscode.postMessage({ type: "requestAgents" })
    const tick = setInterval(() => {
      if (!hold) load()
    }, 4000)
    onCleanup(() => clearInterval(tick))
  })

  const unsub = vscode.onMessage((msg: ExtensionMessage) => {
    if (msg.type === "routineState") {
      if (msg.error) {
        setError(msg.error)
        hold = false
        setSaving(false)
      }
      if (msg.agents) {
        if (!msg.error) setError("")
        setAgents(msg.agents as Agent[])
        if (msg.saved && !msg.error) {
          hold = false
          setSaving(false)
          setScreen("roster")
          setPicked({})
        }
      }
      if (msg.templates) setTemplates(msg.templates as Template[])
    }
    if (msg.type === "routineRuns" && msg.agentID) {
      setRuns((prior) => ({ ...prior, [msg.agentID]: msg.runs as Run[] }))
      setBusy((prior) => {
        const next = { ...prior }
        delete next[msg.agentID]
        return next
      })
    }
    if ((msg.type === "sessionStatus" || msg.type === "sessionTurnClosed") && !hold) load()
  })
  onCleanup(unsub)

  const picks = createMemo<Choice[]>(() => {
    const extras = session
      .agents()
      .filter((item) => !item.hidden)
      .map((item) => ({ key: item.name, label: title(item) }))
    extras.sort((a, b) => a.label.localeCompare(b.label))
    return [chat, ...extras]
  })

  const current = createMemo(() => picks().find((item) => item.key === mode()) ?? chat)

  const pick = (next: string) => {
    setRole(next)
    if (next === "accountant") setMoney(true)
    if (next === "inbox") setMessages(true)
    if (next !== "accountant") setMoney(false)
    if (next !== "inbox") setMessages(false)
    setAccess(next === "briefer" ? "brief" : "full")
  }

  const apply = (item: Template) => {
    setScreen("assign")
    setName(item.name)
    pick(item.role)
    setObjective(item.objective)
    setMoney(item.capabilities.includes("money"))
    setMessages(item.capabilities.includes("messages"))
    if (item.schedule.kind === "cron") setWhen(whenLabel(item.schedule))
    if (item.schedule.kind === "manual") setWhen("just when I ask")
  }

  const create = () => {
    setError("")
    setSaving(true)
    hold = true
    const capabilities = [money() ? "money" : "", messages() ? "messages" : ""].filter(Boolean)
    const chosen = current()
    vscode.postMessage({
      type: "routineCreate",
      name: name() || (role() === "custom" ? custom() : role()),
      role: role() === "custom" ? custom().trim() || "custom" : role(),
      objective: objective(),
      when: when(),
      capabilities,
      plan: plan().trim() || undefined,
      access: access(),
      mode: chosen.key === "chat" ? undefined : chosen.key,
    })
  }

  const toggle = (item: Agent) =>
    vscode.postMessage({ type: "routineUpdate", agentID: item.id, enabled: !item.enabled })

  const fire = (item: Agent) => {
    if (busy()[item.id]) return
    const last = latest(item, runs())
    if (last?.status === "running") return
    setBusy((prior) => ({ ...prior, [item.id]: true }))
    vscode.postMessage({ type: "routineRun", agentID: item.id })
  }

  const open = (item: Agent) => {
    const run = latest(item, runs())
    if (run?.sessionID) props.onOpenSession?.(run.sessionID)
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
          <span>Past chats stay in History. This cannot be undone from the roster.</span>
          <div class="dialog-confirm-actions">
            <Button variant="secondary" size="large" onClick={() => dialog.close()}>
              Keep
            </Button>
            <Button
              variant="ghost"
              size="large"
              class="dialog-destructive-btn"
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
    const last = latest(item, runs())
    return runPresence({
      busy: last?.status === "running" || !!busy()[item.id],
      waiting: last?.status === "blocked",
      done: last?.status === "complete",
      error: last?.status === "error",
    })
  }

  const empty = createMemo(() => agents().length === 0)
  const roleOpt = createMemo(() => roles.find((item) => item.id === role()) ?? roles[0])
  const workOpt = createMemo(() => work.find((item) => item.id === access()) ?? work[0])

  return (
    <div class="routines-view history-view">
      <div class="history-view-header">
        <Show when={props.onBack}>
          <Button variant="ghost" size="small" icon="arrow-left" onClick={props.onBack}>
            {language.t("common.goBack")}
          </Button>
        </Show>
        <Show when={screen() === "roster" && !empty()}>
          <Checkbox
            hideLabel
            checked={allOn()}
            indeterminate={someOn()}
            onChange={markAll}
          >
            Select all
          </Checkbox>
        </Show>
        <h2 class="routines-title">{screen() === "assign" ? "Assign a routine" : "Routines"}</h2>
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
          <Button class="routines-header-action" variant="ghost" size="small" onClick={() => setScreen("roster")}>
            Done
          </Button>
        </Show>
      </div>
      <div class="routines-body">
        <Show when={error()}>
          <p class="routines-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={screen() === "roster"}>
          <Show when={empty()}>
            <div class="routines-empty-block">
              <p class="routines-empty">No standing jobs yet. Assign one and it will sleep until it is time to work.</p>
              <Button onClick={() => setScreen("assign")}>Assign a routine</Button>
            </div>
          </Show>
          <ul class="routines-list">
            <For each={agents()}>
              {(item) => {
                const run = () => latest(item, runs())
                const presence = () => state(item)
                const canOpen = () => !!run()?.sessionID
                const on = () => !!picked()[item.id]
                return (
                  <li
                    class="routines-row"
                    data-presence={presence()}
                    data-paused={item.enabled ? undefined : "true"}
                    data-picked={on() ? "true" : undefined}
                  >
                    <Checkbox hideLabel checked={on()} onChange={(value) => mark(item.id, value)}>
                      Select {item.name}
                    </Checkbox>
                    <button
                      type="button"
                      class="routines-identity"
                      disabled={!canOpen()}
                      onClick={() => open(item)}
                    >
                      <span class="routines-name">{item.name}</span>
                      <span class="routines-meta">{meta(item)}</span>
                      <span class="routines-job">{item.objective}</span>
                    </button>
                    <div class="routines-side">
                      <PresenceBadge state={presence()} onAck={canOpen() ? () => open(item) : undefined} />
                      <div class="routines-actions">
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!!busy()[item.id] || run()?.status === "running"}
                          onClick={() => fire(item)}
                        >
                          {busy()[item.id] || run()?.status === "running" ? "Running" : "Run now"}
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => toggle(item)}>
                          {item.enabled ? "Pause" : "Enable"}
                        </Button>
                        <IconButton
                          icon="trash"
                          size="small"
                          variant="ghost"
                          aria-label={`Remove ${item.name}`}
                          onClick={() => confirm([item.id])}
                        />
                      </div>
                    </div>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
        <Show when={screen() === "assign"}>
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
            <label class="routines-field">
              When
              <input
                value={when()}
                onInput={(e) => setWhen(e.currentTarget.value)}
                placeholder="every weekday at 6pm"
              />
            </label>
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
            <div class="routines-field">
              <span>How it works</span>
              <Select
                options={work}
                current={workOpt()}
                label={(item) => item.label}
                value={(item) => item.id}
                onSelect={(item) => item && setAccess(item.id)}
                variant="secondary"
                size="small"
              />
            </div>
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
            <label class="routines-field">
              Plan file
              <input
                value={plan()}
                onInput={(e) => setPlan(e.currentTarget.value)}
                placeholder="Optional path to a .md plan"
              />
            </label>
            <Button type="submit" disabled={!objective().trim() || saving()}>
              {saving() ? "Assigning" : "Assign"}
            </Button>
          </form>
        </Show>
      </div>
    </div>
  )
}

export default RoutinesView
