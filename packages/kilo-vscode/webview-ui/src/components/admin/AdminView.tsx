import { Button } from "@kilocode/kilo-ui/button"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useServer } from "../../context/server"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import type { AdminEntry, AdminRow } from "../../../../src/shared/admin"

const ids = [
  "runtime",
  "sessions",
  "goals",
  "routines",
  "organizations",
  "scheduler",
  "agents",
  "skills",
  "todos",
  "contacts",
  "browser",
  "computer",
  "voice",
  "memory",
  "canvas",
  "sync",
  "updates",
] as const
const names: Record<(typeof ids)[number], string> = {
  runtime: "Runtime",
  sessions: "Sessions",
  goals: "Goals",
  routines: "Routines",
  organizations: "Organizations",
  scheduler: "Scheduler",
  agents: "Agents",
  skills: "Skills",
  todos: "Todos",
  contacts: "Contacts",
  browser: "Browser",
  computer: "Computer use",
  voice: "Voice",
  memory: "Memory",
  canvas: "Canvas",
  sync: "Cloud sync",
  updates: "Updates",
}
const states: Record<AdminRow["status"], string> = {
  healthy: "Healthy",
  degraded: "Needs attention",
  blocked: "Blocked",
  offline: "Offline",
  unknown: "Unknown",
}
type Fields = NonNullable<AdminEntry["fields"]>
const signals: Record<NonNullable<Fields["state"]>, string> = {
  healthy: "Healthy",
  degraded: "Needs attention",
  blocked: "Blocked",
  offline: "Offline",
  unknown: "Unknown",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
}
const reasons: Record<AdminRow["reason"], string> = {
  ready: "Ready",
  connecting: "Connecting",
  disconnected: "Disconnected",
  "runtime-error": "Runtime unavailable",
  "storage-unreadable": "Session storage unavailable",
  "stream-error": "Session updates unavailable",
  "goal-blocked": "A goal is blocked",
  "goal-state-unreadable": "Goal state is incomplete",
  "goal-inventory-incomplete": "Some goals were not checked",
  "scheduler-recovery": "Scheduled work needs recovery",
  "scheduler-state-unreadable": "Scheduler state is incomplete",
  "scheduler-inventory-incomplete": "Some scheduler state was not checked",
  "routine-blocked": "A routine is blocked",
  "routine-recovery": "A routine needs recovery",
  "routine-history-unreadable": "Routine history is incomplete",
  "agent-recovery": "An agent needs recovery",
  "browser-closed": "Browser closed",
  "browser-unavailable": "Browser unavailable",
  "browser-locked": "Browser locked",
  "browser-error": "Browser needs attention",
  "browser-auth-expired": "Browser sign-in expired",
  "voice-unavailable": "Voice unavailable",
  "voice-failed": "Voice needs attention",
  "voice-incomplete": "Voice result incomplete",
  "not-checked": "No signal available",
  "probe-failed": "Check unavailable",
}
const sources: Record<NonNullable<Fields["source"]>, string> = {
  runtime: "Runtime",
  sessions: "Sessions",
  goals: "Goals",
  routines: "Routines",
  organizations: "Organizations",
  scheduler: "Scheduler",
  agents: "Agents",
  skills: "Skills",
  todos: "Todos",
  contacts: "Contacts",
  browser: "Browser",
  computer: "Computer use",
  voice: "Voice",
  memory: "Memory",
  canvas: "Canvas",
  sync: "Cloud sync",
  updates: "Updates",
  registry: "Health registry",
  host: "Extension host",
}
const channels: Record<NonNullable<Fields["channel"]>, string> = {
  raya: "Raya inbox",
  email: "Email",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
}
const scopes: Record<NonNullable<Fields["scope"]>, string> = {
  global: "All workers",
  agent: "One worker",
  organization: "One organization",
}

export function AdminView(props: { onBack: () => void }) {
  const vscode = useVSCode()
  const server = useServer()
  const [health, setHealth] = createSignal<Extract<ExtensionMessage, { type: "adminResult" }>["health"]>()
  const [logs, setLogs] = createSignal<AdminEntry[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [kind, setKind] = createSignal<"offline" | "error">()
  let request = ""
  let scope = ""

  const refresh = () => {
    if (!server.isConnected()) {
      setLoading(false)
      setKind("offline")
      setError("Raya is disconnected. Reconnect to check system health.")
      return
    }
    request = crypto.randomUUID()
    setLoading(true)
    setError()
    setKind()
    vscode.postMessage({ type: "requestAdmin", requestID: request })
  }

  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "adminResult" || message.requestID !== request) return
    setLoading(false)
    if (message.health) setHealth(message.health)
    if (message.logs) setLogs(message.logs)
    setKind(message.error?.kind)
    setError(message.error?.message)
  })
  onCleanup(unsubscribe)

  createEffect(() => {
    const next = `${server.isConnected() ? "1" : "0"}:${server.workspaceDirectory()}`
    if (next === scope) return
    scope = next
    setHealth()
    setLogs([])
    refresh()
  })

  const rows = createMemo<AdminRow[]>(() => {
    const found = new Map(health()?.items.map((row) => [row.id, row]))
    return ids.map((id) => {
      const row = found.get(id)
      if (row) return row
      const offline = kind() === "offline"
      return {
        id,
        status: id === "runtime" && offline ? "offline" : "unknown",
        reason: offline ? "disconnected" : "not-checked",
        observedAt: 0,
      }
    })
  })

  const summary = createMemo(() => {
    if (kind() === "offline") return "Disconnected"
    const items = rows()
    if (items.some((row) => row.status === "offline" || row.status === "blocked")) return "Action needed"
    if (items.some((row) => row.status === "degraded" || row.status === "unknown")) return "Partial"
    return "All systems ready"
  })

  const detail = (entry: AdminEntry) => {
    const fields = entry.fields
    if (!fields) return ""
    return [
      fields.durationMs === undefined ? undefined : `${fields.durationMs} ms`,
      fields.count === undefined ? undefined : `Count ${fields.count}`,
      fields.attempt === undefined ? undefined : `Attempt ${fields.attempt}`,
      fields.generation === undefined ? undefined : `Generation ${fields.generation}`,
      fields.state ? signals[fields.state] : undefined,
      fields.reason ? reasons[fields.reason] : undefined,
      fields.source ? sources[fields.source] : undefined,
      fields.version ? `Version ${fields.version}` : undefined,
      fields.channel ? channels[fields.channel] : undefined,
      fields.scope ? scopes[fields.scope] : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(", ")
  }

  return (
    <main class="admin-view" aria-labelledby="admin-title">
      <header class="admin-header">
        <Button variant="ghost" size="small" icon="arrow-left" onClick={props.onBack}>
          Back
        </Button>
        <Button variant="secondary" size="small" icon="refresh" disabled={loading()} onClick={refresh}>
          Refresh
        </Button>
      </header>

      <section class="admin-intro">
        <p class="admin-eyebrow">Admin</p>
        <h1 id="admin-title">System health</h1>
        <p>Read-only status from Raya's local services.</p>
        <strong>{summary()}</strong>
      </section>

      <Show when={error()}>
        <div class="admin-notice" data-kind={kind()} role={kind() === "error" ? "alert" : "status"}>
          <span>{error()}</span>
          <Button variant="ghost" size="small" onClick={refresh}>
            Try again
          </Button>
        </div>
      </Show>

      <section aria-labelledby="admin-services-title">
        <div class="admin-section-heading">
          <h2 id="admin-services-title">Services</h2>
          <Show when={loading()}>
            <Spinner aria-label="Checking system health" />
          </Show>
        </div>
        <div class="admin-rows" aria-busy={loading()}>
          <For each={rows()}>
            {(row) => (
              <div class="admin-row">
                <div>
                  <strong>{names[row.id]}</strong>
                  <span>{reasons[row.reason]}</span>
                </div>
                <span class="admin-status" data-status={row.status}>
                  {states[row.status]}
                </span>
              </div>
            )}
          </For>
        </div>
      </section>

      <section aria-labelledby="admin-log-title">
        <div class="admin-section-heading">
          <h2 id="admin-log-title">Recent diagnostics</h2>
        </div>
        <Show
          when={logs().length}
          fallback={<p class="admin-empty">No diagnostic entries yet. Refresh to run a health check.</p>}
        >
          <ol class="admin-log">
            <For each={logs()}>
              {(entry) => (
                <li>
                  <div>
                    <strong>{names[entry.subsystem]}</strong>
                    <span>{entry.code.replaceAll(".", " ")}</span>
                  </div>
                  <Show when={detail(entry)}>
                    <p>{detail(entry)}</p>
                  </Show>
                  <time datetime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </time>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>
    </main>
  )
}
