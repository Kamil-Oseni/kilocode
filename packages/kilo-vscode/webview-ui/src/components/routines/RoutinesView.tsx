import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { PresenceBadge } from "../chat/PresenceBadge"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { runPresence } from "../../utils/run-presence"
import type { ExtensionMessage } from "../../types/messages"

type Schedule =
  | { kind: "once"; at: number }
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "event"; source: string; filter?: string }
  | { kind: "manual" }

type Agent = {
  id: string
  name: string
  avatar?: string
  role: string
  objective: string
  capabilities: string[]
  schedule: Schedule
  enabled: boolean
  note?: string
  nextRun?: number
  model?: { providerID: string; id: string }
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

function cost(run: Run) {
  if (!run.outcome) return ""
  return ` · ${run.outcome.summary} · $${run.outcome.cost.toFixed(2)}`
}

function stamp(run: Run) {
  if (run.status === "blocked") return run.blockedReason || "waiting on you"
  return run.status
}

interface RoutinesViewProps {
  onBack?: () => void
  onOpenSession?: (id: string) => void
}

const RoutinesView: Component<RoutinesViewProps> = (props) => {
  const vscode = useVSCode()
  const language = useLanguage()
  const provider = useProvider()
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
  const [model, setModel] = createSignal("")
  const [access, setAccess] = createSignal<"full" | "brief">("brief")
  const [screen, setScreen] = createSignal<"roster" | "assign">("roster")
  const [busy, setBusy] = createSignal<Record<string, true>>({})
  const [drop, setDrop] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  let hold = false

  const load = () => vscode.postMessage({ type: "routineList" })

  onMount(() => {
    load()
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

  const pick = (next: string) => {
    setRole(next)
    if (next === "accountant") setMoney(true)
    if (next === "inbox") setMessages(true)
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
    const [providerID, ...rest] = model().split("/")
    const modelID = rest.join("/")
    vscode.postMessage({
      type: "routineCreate",
      name: name() || (role() === "custom" ? custom() : role()),
      role: role() === "custom" ? custom().trim() || "custom" : role(),
      objective: objective(),
      when: when(),
      capabilities,
      plan: plan().trim() || undefined,
      access: access(),
      providerID: providerID || undefined,
      modelID: modelID || undefined,
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

  const remove = (id: string) => {
    vscode.postMessage({ type: "routineRemove", agentID: id })
    setDrop("")
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
  const hint = createMemo(() => {
    if (role() === "accountant") return "Accountant jobs need Money tools before they can be assigned."
    if (role() === "inbox") return "Inbox jobs need Messages tools before they can be assigned."
    if (access() === "brief") return "This routine can read and notify. It cannot edit files or run the terminal."
    return "This routine can write files and use every tool."
  })
  const models = createMemo(() =>
    provider
      .models()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  return (
    <div class="routines-view history-view">
      <div class="history-view-header">
        <Show when={props.onBack}>
          <Button variant="ghost" size="small" icon="arrow-left" onClick={props.onBack}>
            {language.t("common.goBack")}
          </Button>
        </Show>
        <h2 class="routines-title">{screen() === "assign" ? "Assign a routine" : "Routines"}</h2>
        <Show when={screen() === "roster"}>
          <Button class="routines-header-action" variant="ghost" size="small" onClick={() => setScreen("assign")}>
            Assign
          </Button>
        </Show>
        <Show when={screen() === "assign"}>
          <Button class="routines-header-action" variant="ghost" size="small" onClick={() => setScreen("roster")}>
            Roster
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
              <p class="routines-empty">No routines yet. Assign a standing job and it will sleep until it is time to work.</p>
              <Button onClick={() => setScreen("assign")}>Assign a routine</Button>
            </div>
          </Show>
          <ul class="routines-list">
            <For each={agents()}>
              {(item) => {
                const run = () => latest(item, runs())
                const presence = () => state(item)
                const recent = () => (runs()[item.id] ?? []).slice(-2).reverse()
                const canOpen = () => !!run()?.sessionID
                return (
                  <li class="routines-row" data-presence={presence()} data-paused={item.enabled ? undefined : "true"}>
                    <div class="routines-row-top">
                      <button
                        type="button"
                        class="routines-identity"
                        disabled={!canOpen()}
                        onClick={() => open(item)}
                      >
                        <span class="routines-name">{item.name}</span>
                        <span class="routines-role">{item.role}</span>
                      </button>
                      <PresenceBadge state={presence()} onAck={canOpen() ? () => open(item) : undefined} />
                    </div>
                    <p class="routines-job">{item.objective}</p>
                    <p class="routines-when">
                      {item.enabled ? "" : "Paused · "}
                      {item.nextRun ? `Next ${new Date(item.nextRun).toLocaleString()}` : whenLabel(item.schedule)}
                      {item.access === "brief" || (!item.access && item.role === "briefer") ? " · Notify only" : ""}
                    </p>
                    <Show when={item.note}>
                      <p class="routines-note">{item.note}</p>
                    </Show>
                    <div class="routines-actions">
                      <Show when={canOpen()}>
                        <Button size="small" variant="secondary" onClick={() => open(item)}>
                          Open chat
                        </Button>
                      </Show>
                      <Button size="small" variant="ghost" onClick={() => toggle(item)}>
                        {item.enabled ? "Pause" : "Enable"}
                      </Button>
                      <Button
                        size="small"
                        disabled={!!busy()[item.id] || run()?.status === "running"}
                        onClick={() => fire(item)}
                      >
                        {busy()[item.id] || run()?.status === "running" ? "Running" : "Run now"}
                      </Button>
                      <Show when={drop() !== item.id}>
                        <Button size="small" variant="ghost" onClick={() => setDrop(item.id)}>
                          Remove
                        </Button>
                      </Show>
                    </div>
                    <Show when={drop() === item.id}>
                      <p class="routines-confirm">
                        Remove {item.name}? Past chats stay in History.
                        <Button size="small" variant="ghost" onClick={() => setDrop("")}>
                          Keep
                        </Button>
                        <Button size="small" onClick={() => remove(item.id)}>
                          Remove
                        </Button>
                      </p>
                    </Show>
                    <Show when={recent().length}>
                      <ul class="routines-runs">
                        <For each={recent()}>
                          {(row) => (
                            <li>
                              <button
                                type="button"
                                class="routines-run"
                                onClick={() => props.onOpenSession?.(row.sessionID)}
                              >
                                {stamp(row)} · {new Date(row.at).toLocaleString()}
                                {cost(row)}
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
        <Show when={screen() === "assign"}>
          <p class="routines-lede">Give someone a standing job in plain language. Start from a role, or write your own.</p>
          <div class="routines-suggest">
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
            <label class="routines-field">
              Role
              <select value={role()} onChange={(e) => pick(e.currentTarget.value)}>
                <For each={roles}>{(item) => <option value={item.id}>{item.label}</option>}</For>
              </select>
            </label>
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
              Model
              <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
                <option value="">Same as chat</option>
                <For each={models()}>
                  {(item) => (
                    <option value={`${item.providerID}/${item.id}`}>
                      {item.providerName} · {item.name}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="routines-field">
              Tools
              <select value={access()} onChange={(e) => setAccess(e.currentTarget.value as "full" | "brief")}>
                <option value="full">All tools, including writes</option>
                <option value="brief">Read and notify only</option>
              </select>
            </label>
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
            <label class="routines-field">
              Plan file
              <input
                value={plan()}
                onInput={(e) => setPlan(e.currentTarget.value)}
                placeholder="Optional path to a .md plan"
              />
            </label>
            <Checkbox checked={money()} onChange={setMoney}>
              Money tools
            </Checkbox>
            <Checkbox checked={messages()} onChange={setMessages}>
              Messages tools
            </Checkbox>
            <p class="routines-hint">{hint()}</p>
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
