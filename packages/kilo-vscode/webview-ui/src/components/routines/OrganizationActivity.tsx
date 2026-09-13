import { Button } from "@kilocode/kilo-ui/button"
import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"

type Work = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationActivityResponse["items"][number]

const states = new Set(["queued", "accepted", "running", "needs_input", "completed", "failed", "cancelled"])

function person(value: unknown) {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    !!row.name.trim() &&
    typeof row.role === "string" &&
    !!row.role.trim() &&
    typeof row.archived === "boolean"
  )
}

function optional(row: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => row[key] === undefined || typeof row[key] === "string")
}

function valid(value: unknown): value is Work {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  if (!person(row.sender) || !person(row.recipient)) return false
  if (!optional(row, ["organizationName", "expected", "context", "parentID", "parentRunID", "response", "reason"]))
    return false
  if (row.cost !== undefined && (typeof row.cost !== "number" || !Number.isFinite(row.cost) || row.cost < 0))
    return false
  return (
    typeof row.id === "string" &&
    typeof row.organizationID === "string" &&
    /^org_[a-f0-9]{32}$/.test(row.organizationID) &&
    typeof row.source === "string" &&
    typeof row.state === "string" &&
    states.has(row.state) &&
    typeof row.objective === "string" &&
    typeof row.time === "number" &&
    Number.isFinite(row.time) &&
    typeof row.updated === "number" &&
    Number.isFinite(row.updated)
  )
}

function label(state: Work["state"]) {
  if (state === "needs_input") return "Needs input"
  if (state === "accepted") return "Starting"
  return state[0]!.toUpperCase() + state.slice(1)
}

function stamp(value: number) {
  return new Date(value).toLocaleString()
}

export const OrganizationActivity: Component<{
  id: string
  onChoose: (id: string) => void
  onOpenSession?: (id: string) => void
}> = (props) => {
  const vscode = useVSCode()
  const [items, setItems] = createSignal<Work[]>([])
  const [next, setNext] = createSignal<string>()
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal("")
  let request = ""
  let after: string | undefined

  const load = (cursor?: string) => {
    request = crypto.randomUUID()
    after = cursor
    setBusy(true)
    setError("")
    vscode.postMessage({
      type: "routineOrganizationActivity",
      requestID: request,
      organizationID: props.id,
      ...(cursor ? { cursor } : {}),
    })
  }

  const receive = (msg: ExtensionMessage) => {
    if (msg.type !== "routineOrganizationActivity" || msg.requestID !== request || msg.organizationID !== props.id)
      return
    setBusy(false)
    if (msg.error) {
      setError(msg.error)
      return
    }
    const rows = (msg.items ?? []).filter(valid).filter((item) => item.organizationID === props.id)
    if (!after) setItems(rows)
    else setItems((prior) => [...prior, ...rows.filter((row) => !prior.some((item) => item.id === row.id))])
    setNext(msg.next)
  }

  const unsub = vscode.onMessage(receive)
  onCleanup(unsub)
  onMount(() => load())

  const active = createMemo(
    () => items().filter((item) => ["queued", "accepted", "running", "needs_input"].includes(item.state)).length,
  )
  const attention = createMemo(
    () => items().filter((item) => item.state === "needs_input" || item.state === "failed").length,
  )

  return (
    <section class="routines-organization-work" aria-labelledby={`organization-work-${props.id}`}>
      <div class="routines-organization-work-head">
        <div>
          <h3 id={`organization-work-${props.id}`}>Work</h3>
          <Show when={items().length}>
            <p>
              {active()} active{attention() ? ` · ${attention()} need attention` : ""}
            </p>
          </Show>
        </div>
        <Button variant="ghost" size="small" disabled={busy()} onClick={() => load()}>
          Refresh work
        </Button>
      </div>
      <Show when={items().length}>
        <ol class="routines-organization-work-list">
          <For each={items()}>
            {(item) => (
              <li>
                <div class="routines-organization-work-route">
                  <button type="button" onClick={() => props.onChoose(item.sender.id)}>
                    {item.sender.name}
                  </button>
                  <span aria-hidden="true">→</span>
                  <button type="button" onClick={() => props.onChoose(item.recipient.id)}>
                    {item.recipient.name}
                  </button>
                  <span class="routines-organization-work-state" data-state={item.state}>
                    {label(item.state)}
                  </span>
                </div>
                <p class="routines-organization-work-objective">{item.objective}</p>
                <Show when={item.response}>
                  <p class="routines-organization-work-result">{item.response}</p>
                </Show>
                <Show when={item.reason}>
                  <p class="routines-error">{item.reason}</p>
                </Show>
                <div class="routines-organization-work-meta">
                  <span>Updated {stamp(item.updated)}</span>
                  <Show when={item.parentID}>
                    <span>Follow-on work</span>
                  </Show>
                  <Show when={typeof item.cost === "number"}>
                    <span>Recorded cost ${item.cost}</span>
                  </Show>
                  <Show when={item.sessionID && props.onOpenSession}>
                    <button type="button" onClick={() => props.onOpenSession?.(item.sessionID!)}>
                      Open run
                    </button>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={!items().length && !error()}>
        <p class="routines-empty">{busy() ? "Loading work…" : "No delegated work yet."}</p>
      </Show>
      <Show when={error()}>
        <p class="routines-error" role="alert">
          {error()}
        </p>
        <Button variant="ghost" size="small" onClick={() => load(after)}>
          Retry work
        </Button>
      </Show>
      <Show when={next()}>
        <Button variant="ghost" size="small" disabled={busy()} onClick={() => load(next())}>
          Load earlier work
        </Button>
      </Show>
    </section>
  )
}
