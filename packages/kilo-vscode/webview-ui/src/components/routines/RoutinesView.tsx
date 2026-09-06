import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { runPresence, presenceLabel } from "../../utils/run-presence"
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

function whenLabel(schedule: Schedule) {
  if (schedule.kind === "manual") return "When you ask"
  if (schedule.kind === "once") return new Date(schedule.at).toLocaleString()
  if (schedule.kind === "event") return `On ${schedule.source}${schedule.filter ? ` (${schedule.filter})` : ""}`
  if (schedule.expr === "0 18 * * 1-5") return "Weekdays at 6pm"
  if (schedule.expr === "0 9 * * 1-5") return "Weekday mornings"
  if (schedule.expr === "0 9 * * *") return "Every morning"
  return schedule.expr
}

interface RoutinesViewProps {
  onBack?: () => void
  onOpenSession?: (id: string) => void
}

const RoutinesView: Component<RoutinesViewProps> = (props) => {
  const vscode = useVSCode()
  const language = useLanguage()
  const [agents, setAgents] = createSignal<Agent[]>([])
  const [templates, setTemplates] = createSignal<Template[]>([])
  const [runs, setRuns] = createSignal<Record<string, Run[]>>({})
  const [error, setError] = createSignal("")
  const [name, setName] = createSignal("")
  const [role, setRole] = createSignal("briefer")
  const [objective, setObjective] = createSignal("")
  const [when, setWhen] = createSignal("every weekday at 6pm")
  const [money, setMoney] = createSignal(false)
  const [messages, setMessages] = createSignal(false)
  const [plan, setPlan] = createSignal("")

  const load = () => vscode.postMessage({ type: "routineList" })
  onMount(() => {
    load()
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data
      if (msg.type === "routineState") {
        if (msg.error) setError(msg.error)
        if (msg.templates) setTemplates(msg.templates as Template[])
        if (msg.agents) setAgents(msg.agents as Agent[])
      }
      if (msg.type === "routineRuns" && msg.agentID) {
        setRuns((prior) => ({ ...prior, [msg.agentID]: msg.runs as Run[] }))
      }
    }
    window.addEventListener("message", handler)
    onCleanup(() => window.removeEventListener("message", handler))
  })

  const apply = (item: Template) => {
    setName(item.name)
    setRole(item.role)
    setObjective(item.objective)
    setMoney(item.capabilities.includes("money"))
    setMessages(item.capabilities.includes("messages"))
    if (item.schedule.kind === "cron") setWhen(whenLabel(item.schedule))
    if (item.schedule.kind === "manual") setWhen("just when I ask")
  }

  const create = () => {
    setError("")
    const capabilities = [money() ? "money" : "", messages() ? "messages" : ""].filter(Boolean)
    vscode.postMessage({
      type: "routineCreate",
      name: name() || role(),
      role: role(),
      objective: objective(),
      when: when(),
      capabilities,
      plan: plan().trim() || undefined,
    })
  }

  const toggle = (item: Agent) =>
    vscode.postMessage({ type: "routineUpdate", agentID: item.id, enabled: !item.enabled })

  const fire = (item: Agent) => vscode.postMessage({ type: "routineRun", agentID: item.id })

  const state = (item: Agent) => {
    const last = (runs()[item.id] ?? []).at(-1)
    return runPresence({
      busy: last?.status === "running",
      waiting: last?.status === "blocked",
      done: last?.status === "complete",
      error: last?.status === "error",
    })
  }

  const [asked, setAsked] = createSignal<ReadonlySet<string>>(new Set())
  createEffect(() => {
    const next = new Set(asked())
    for (const item of agents()) {
      if (next.has(item.id)) continue
      next.add(item.id)
      vscode.postMessage({ type: "routineRuns", agentID: item.id })
    }
    if (next.size !== asked().size) setAsked(next)
  })

  const empty = createMemo(() => agents().length === 0)

  return (
    <div class="routines-view">
      <div class="history-view-header">
        <Show when={props.onBack}>
          <Button variant="ghost" size="small" onClick={props.onBack}>
            {language.t("common.back")}
          </Button>
        </Show>
        <h2 class="routines-title">Routines</h2>
      </div>
      <Show when={error()}>
        <p class="routines-error">{error()}</p>
      </Show>
      <section class="routines-templates">
        <p class="routines-lede">Assign a standing job in plain language. Start from a template or write your own.</p>
        <div class="routines-template-row">
          <For each={templates()}>
            {(item) => (
              <button type="button" class="routines-chip" onClick={() => apply(item)}>
                {item.name}
              </button>
            )}
          </For>
        </div>
      </section>
      <form
        class="routines-form"
        onSubmit={(event) => {
          event.preventDefault()
          create()
        }}
      >
        <label>
          Name
          <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="Nightly review" />
        </label>
        <label>
          Role
          <select value={role()} onChange={(e) => setRole(e.currentTarget.value)}>
            <option value="briefer">Briefer</option>
            <option value="reviewer">Reviewer</option>
            <option value="accountant">Accountant</option>
            <option value="inbox">Inbox</option>
            <option value="designer">Designer</option>
            <option value="coder">Coder</option>
            <option value="generalist">Generalist</option>
          </select>
        </label>
        <label>
          Standing job
          <textarea
            value={objective()}
            onInput={(e) => setObjective(e.currentTarget.value)}
            placeholder="Review the repo for bugs every weekday evening."
            rows={3}
          />
        </label>
        <label>
          When
          <input
            value={when()}
            onInput={(e) => setWhen(e.currentTarget.value)}
            placeholder="every weekday at 6pm"
          />
        </label>
        <label>
          Plan file (optional)
          <input
            value={plan()}
            onInput={(e) => setPlan(e.currentTarget.value)}
            placeholder="path to a .md plan"
          />
        </label>
        <label class="routines-check">
          <input type="checkbox" checked={money()} onChange={(e) => setMoney(e.currentTarget.checked)} />
          Money tools
        </label>
        <label class="routines-check">
          <input type="checkbox" checked={messages()} onChange={(e) => setMessages(e.currentTarget.checked)} />
          Messages tools
        </label>
        <Button type="submit" disabled={!objective().trim()}>
          Assign
        </Button>
      </form>
      <Show when={empty()}>
        <p class="routines-empty">No assigned agents yet. Pick a template, then Assign.</p>
      </Show>
      <ul class="routines-list">
        <For each={agents()}>
          {(item) => {
            const presence = () => state(item)
            const word = () => presenceLabel(presence())
            return (
              <li class="routines-card" data-presence={presence()}>
                <div class="routines-card-head">
                  <strong>{item.name}</strong>
                  <span class="routines-role">{item.role}</span>
                  <Show when={word()}>
                    <span class="presence-badge" data-presence={presence()}>
                      {word()}
                    </span>
                  </Show>
                </div>
                <p class="routines-job">{item.objective}</p>
                <p class="routines-when">
                  {item.nextRun ? `Next: ${new Date(item.nextRun).toLocaleString()}` : whenLabel(item.schedule)}
                </p>
                <Show when={item.note}>
                  <p class="routines-note">{item.note}</p>
                </Show>
                <div class="routines-actions">
                  <Button size="small" variant="secondary" onClick={() => toggle(item)}>
                    {item.enabled ? "Pause" : "Enable"}
                  </Button>
                  <Button size="small" onClick={() => fire(item)}>
                    Run now
                  </Button>
                </div>
                <ul class="routines-runs">
                  <For each={runs()[item.id] ?? []}>
                    {(run) => (
                      <li>
                        <button
                          type="button"
                          class="routines-run"
                          onClick={() => props.onOpenSession?.(run.sessionID)}
                        >
                          {run.status} · {new Date(run.at).toLocaleString()}
                          <Show when={run.outcome}>
                            {" "}
                            · {run.outcome!.summary} · ${run.outcome!.cost.toFixed(2)}
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </li>
            )
          }}
        </For>
      </ul>
    </div>
  )
}

export default RoutinesView
