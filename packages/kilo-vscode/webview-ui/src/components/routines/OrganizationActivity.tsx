import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { OrganizationAssignment } from "./OrganizationAssignment"

type Work = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationActivityResponse["items"][number]
type Step = Pick<Work, "id" | "state" | "objective" | "organizationID"> & {
  senderID: string
  recipientID: string
}
type Tree = { record: Step; above: Step[]; below: Step[] }

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

function step(value: unknown): Step | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  if (
    typeof row.id !== "string" ||
    typeof row.senderID !== "string" ||
    typeof row.recipientID !== "string" ||
    typeof row.organizationID !== "string" ||
    typeof row.state !== "string" ||
    !states.has(row.state) ||
    typeof row.objective !== "string"
  )
    return
  return row as Step
}

function chain(value: { record?: unknown; above?: unknown; below?: unknown }, item: Work): Tree | undefined {
  const record = step(value.record)
  if (
    !record ||
    record.id !== item.id ||
    record.senderID !== item.sender.id ||
    record.recipientID !== item.recipient.id
  )
    return
  if (!Array.isArray(value.above) || !Array.isArray(value.below)) return
  const above = value.above.map(step)
  const below = value.below.map(step)
  if ([record, ...above, ...below].some((row) => !row || row.organizationID !== item.organizationID)) return
  return { record, above: above as Step[], below: below as Step[] }
}

function live(state: Work["state"]) {
  return state === "queued" || state === "accepted" || state === "running" || state === "needs_input"
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
  item: import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationListResponse["items"][number]
  agents: { id: string; name: string; enabled: boolean }[]
  onEdit: () => void
  onChoose: (id: string) => void
  onOpenSession?: (id: string) => void
}> = (props) => {
  const vscode = useVSCode()
  const dialog = useDialog()
  const [items, setItems] = createSignal<Work[]>([])
  const [next, setNext] = createSignal<string>()
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal("")
  const [open, setOpen] = createSignal("")
  const [trees, setTrees] = createSignal<Record<string, Tree>>({})
  const [faults, setFaults] = createSignal<Record<string, string>>({})
  const [trace, setTrace] = createSignal<{ request: string; id: string; agent: string }>()
  const [confirm, setConfirm] = createSignal("")
  const [stopping, setStopping] = createSignal<{ request: string; id: string; agent: string; recipient: string }>()
  const [assigned, setAssigned] = createSignal<{ id: string; name: string }>()
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

  const page = (msg: Extract<ExtensionMessage, { type: "routineOrganizationActivity" }>) => {
    if (msg.requestID !== request || msg.organizationID !== props.id) return
    setBusy(false)
    setStopping()
    setConfirm("")
    if (msg.error) {
      setError(msg.error)
      return
    }
    const rows = (msg.items ?? []).filter(valid).filter((item) => item.organizationID === props.id)
    if (!after) setItems(rows)
    else setItems((prior) => [...prior, ...rows.filter((row) => !prior.some((item) => item.id === row.id))])
    setNext(msg.next)
  }

  const lineage = (msg: Extract<ExtensionMessage, { type: "routineDelegateChain" }>) => {
    const active = trace()
    if (!active || msg.requestID !== active.request || msg.agentID !== active.agent || msg.id !== active.id) return
    const item = items().find((row) => row.id === active.id)
    const found = item ? chain({ record: msg.record, above: msg.above, below: msg.below }, item) : undefined
    setTrace()
    if (msg.error || !found) {
      setFaults((prior) => ({
        ...prior,
        [active.id]: msg.error || "The stored request chain could not be verified.",
      }))
      return
    }
    setFaults((prior) => {
      const next = { ...prior }
      delete next[active.id]
      return next
    })
    setTrees((prior) => ({ ...prior, [active.id]: found }))
  }

  const halted = (msg: Extract<ExtensionMessage, { type: "routineDelegateStopped" }>) => {
    const active = stopping()
    if (!active || msg.requestID !== active.request || msg.agentID !== active.agent) return
    const row = msg.record && typeof msg.record === "object" ? (msg.record as Record<string, unknown>) : undefined
    if (
      msg.error ||
      !row ||
      row.id !== active.id ||
      row.senderID !== active.agent ||
      row.recipientID !== active.recipient ||
      row.organizationID !== props.id ||
      (row.state !== "cancelled" && row.state !== "completed" && row.state !== "failed")
    ) {
      setFaults((prior) => ({
        ...prior,
        [active.id]: msg.error || "The stopped work response could not be verified. Refresh before trying again.",
      }))
      setStopping()
      setConfirm("")
      return
    }
    setOpen("")
    setTrees((prior) => {
      const next = { ...prior }
      delete next[active.id]
      return next
    })
    load()
  }

  const receive = (msg: ExtensionMessage) => {
    if (msg.type === "routineOrganizationActivity") return page(msg)
    if (msg.type === "routineDelegateChain") return lineage(msg)
    if (msg.type === "routineDelegateStopped") return halted(msg)
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

  const name = (id: string) => {
    for (const item of items()) {
      if (item.sender.id === id) return item.sender.name
      if (item.recipient.id === id) return item.recipient.name
    }
    return "Retained worker"
  }

  const inspect = (item: Work) => {
    if (trace() && trace()?.id !== item.id) return
    if (open() === item.id) {
      setOpen("")
      return
    }
    setOpen(item.id)
    if (trees()[item.id] || trace()?.id === item.id) return
    const request = crypto.randomUUID()
    setTrace({ request, id: item.id, agent: item.sender.id })
    vscode.postMessage({
      type: "routineDelegateChain",
      requestID: request,
      agentID: item.sender.id,
      id: item.id,
    })
  }

  const stop = (item: Work) => {
    if (stopping()) return
    const request = crypto.randomUUID()
    setStopping({ request, id: item.id, agent: item.sender.id, recipient: item.recipient.id })
    setFaults((prior) => {
      const next = { ...prior }
      delete next[item.id]
      return next
    })
    vscode.postMessage({
      type: "routineDelegateCancel",
      requestID: request,
      agentID: item.sender.id,
      id: item.id,
    })
  }

  const assign = () =>
    dialog.show(() => (
      <OrganizationAssignment
        item={props.item}
        agents={props.agents}
        onEdit={props.onEdit}
        onAssigned={(worker) => {
          setAssigned(worker)
          load()
        }}
      />
    ))

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
        <div class="routines-organization-work-actions">
          <Button size="small" onClick={assign}>
            Assign work
          </Button>
          <Button variant="ghost" size="small" disabled={busy()} onClick={() => load()}>
            Refresh work
          </Button>
        </div>
      </div>
      <Show when={assigned()}>
        {(worker) => (
          <div class="routines-organization-work-notice" role="status">
            <span>Work assigned to {worker().name}.</span>
            <Button variant="ghost" size="small" onClick={() => props.onChoose(worker().id)}>
              Open worker chat
            </Button>
          </div>
        )}
      </Show>
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
                <div class="routines-organization-work-actions">
                  <Button
                    variant="ghost"
                    size="small"
                    aria-expanded={open() === item.id}
                    aria-controls={`organization-chain-${item.id}`}
                    disabled={!!trace()}
                    onClick={() => inspect(item)}
                  >
                    {trace()?.id === item.id ? "Loading chain" : open() === item.id ? "Hide chain" : "Show chain"}
                  </Button>
                  <Show when={live(item.state) && confirm() !== item.id}>
                    <Button variant="ghost" size="small" disabled={!!stopping()} onClick={() => setConfirm(item.id)}>
                      Stop work
                    </Button>
                  </Show>
                </div>
                <Show when={faults()[item.id]}>
                  <p class="routines-error" role="alert">
                    {faults()[item.id]}
                  </p>
                </Show>
                <Show when={confirm() === item.id}>
                  <div class="routines-organization-work-confirm" role="group" aria-label="Confirm stopping work">
                    <p>This stops this request and live follow-on work. Completed results stay saved.</p>
                    <div>
                      <Button variant="ghost" size="small" disabled={!!stopping()} onClick={() => setConfirm("")}>
                        Keep running
                      </Button>
                      <Button variant="destructive" size="small" disabled={!!stopping()} onClick={() => stop(item)}>
                        {stopping()?.id === item.id ? "Stopping" : "Stop work and follow-ons"}
                      </Button>
                    </div>
                  </div>
                </Show>
                <Show when={open() === item.id}>
                  <div id={`organization-chain-${item.id}`}>
                    <Show when={trees()[item.id]}>
                      {(tree) => (
                        <ol class="routines-chain routines-organization-chain" aria-label="Request chain">
                          <For
                            each={[
                              ...tree().above.map((row) => ({ ...row, role: "Prior request" })),
                              { ...tree().record, role: "This request" },
                              ...tree().below.map((row) => ({ ...row, role: "Follow-on request" })),
                            ]}
                          >
                            {(row) => (
                              <li>
                                <span class="routines-line-meta">
                                  {row.role} · {label(row.state)} · {name(row.senderID)} to {name(row.recipientID)}
                                </span>
                                <p class="routines-line-body">{row.objective}</p>
                              </li>
                            )}
                          </For>
                        </ol>
                      )}
                    </Show>
                  </div>
                </Show>
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
