import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { routineFailure } from "../../utils/routine-recovery"
import { OrganizationAssignment, type Follow } from "./OrganizationAssignment"
import { ArtifactList, validArtifacts } from "./ArtifactList"

type Work = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationActivityResponse["items"][number]
type Summary = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationActivityResponse["summary"]
type Step = Pick<Work, "id" | "state" | "objective" | "organizationID"> & {
  senderID: string
  recipientID: string
}
type Tree = { record: Step; above: Step[]; below: Step[] }
type Trace = { request: string; id: string; agent: string; action: "inspect" | "follow" }

const states = new Set<Work["state"]>([
  "queued",
  "accepted",
  "running",
  "needs_input",
  "completed",
  "failed",
  "cancelled",
])

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

function cost(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

function valid(value: unknown): value is Work {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  if (!person(row.sender) || !person(row.recipient)) return false
  if (!optional(row, ["organizationName", "expected", "context", "parentID", "parentRunID", "response", "reason"]))
    return false
  if (!cost(row.cost)) return false
  if (!validArtifacts(row.artifacts)) return false
  return (
    typeof row.id === "string" &&
    typeof row.organizationID === "string" &&
    /^org_[a-f0-9]{32}$/.test(row.organizationID) &&
    typeof row.source === "string" &&
    typeof row.state === "string" &&
    states.has(row.state as Work["state"]) &&
    typeof row.objective === "string" &&
    typeof row.time === "number" &&
    Number.isFinite(row.time) &&
    typeof row.updated === "number" &&
    Number.isFinite(row.updated)
  )
}

function validSummary(value: unknown): value is Summary {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return ["total", "active", "needsAttention", "uncertain", "recordedCost", "committedCost"].every(
    (key) => typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0,
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
    !states.has(row.state as Work["state"]) ||
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
  if (state === "needs_input") return "Waiting for your answer"
  if (state === "accepted") return "Starting"
  return state[0]!.toUpperCase() + state.slice(1)
}

function stamp(value: number) {
  return new Date(value).toLocaleString()
}

function money(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value)
}

export const OrganizationActivity: Component<{
  id: string
  item: import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationListResponse["items"][number]
  agents: { id: string; name: string; enabled: boolean }[]
  receipt?: { id: string; name: string }
  onEdit: () => void
  onChoose: (id: string) => void
  onAssigned: (worker: { id: string; name: string }) => void
  onOpenSession?: (id: string) => void
}> = (props) => {
  const vscode = useVSCode()
  const dialog = useDialog()
  const [items, setItems] = createSignal<Work[]>([])
  const [summary, setSummary] = createSignal<Summary>()
  const [next, setNext] = createSignal<string>()
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal("")
  const [open, setOpen] = createSignal("")
  const [trees, setTrees] = createSignal<Record<string, Tree>>({})
  const [faults, setFaults] = createSignal<Record<string, string>>({})
  const [trace, setTrace] = createSignal<Trace>()
  const [confirm, setConfirm] = createSignal("")
  const [stopping, setStopping] = createSignal<{ request: string; id: string; agent: string; recipient: string }>()
  const [query, setQuery] = createSignal("")
  const [phase, setPhase] = createSignal("all")
  const [worker, setWorker] = createSignal("all")
  let request = ""
  let after: string | undefined

  const available = () => {
    const total = summary()
    if (props.item.budget === undefined || !total) return
    return Math.max(props.item.budget - total.committedCost, 0)
  }

  const assign = (parent?: Follow) =>
    dialog.show(() => (
      <OrganizationAssignment
        item={props.item}
        agents={props.agents}
        parent={parent}
        {...(available() === undefined ? {} : { available: available() })}
        onEdit={props.onEdit}
        onAssigned={(worker) => {
          props.onAssigned(worker)
          if (parent) {
            setOpen("")
            setTrees((prior) => {
              const next = { ...prior }
              delete next[parent.id]
              return next
            })
          }
          load()
        }}
      />
    ))

  const parent = (item: Work, tree: Tree): Follow => ({
    id: item.id,
    ...(item.occurrenceID ? { run: item.occurrenceID } : {}),
    objective: item.objective,
    recipient: item.recipient,
    ...(item.budget !== undefined ? { budget: item.budget } : {}),
    used: [...new Set([tree.record, ...tree.above].flatMap((row) => [row.senderID, row.recipientID]))],
  })

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
      setError(routineFailure(msg.error, msg.recovery))
      return
    }
    if (!validSummary(msg.summary)) {
      setError("The organization totals could not be verified. Refresh and try again.")
      return
    }
    const rows = (msg.items ?? []).filter(valid).filter((item) => item.organizationID === props.id)
    if (!after) setItems(rows)
    else setItems((prior) => [...prior, ...rows.filter((row) => !prior.some((item) => item.id === row.id))])
    setNext(msg.next)
    setSummary(msg.summary)
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
        [active.id]: routineFailure(msg.error, msg.recovery) || "The stored request chain could not be verified.",
      }))
      return
    }
    setFaults((prior) => {
      const next = { ...prior }
      delete next[active.id]
      return next
    })
    setTrees((prior) => ({ ...prior, [active.id]: found }))
    if (active.action === "follow" && item) assign(parent(item, found))
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
        [active.id]:
          routineFailure(msg.error, msg.recovery) ||
          "The stopped work response could not be verified. Refresh before trying again.",
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

  const workers = createMemo(() => {
    const found = new Map<string, string>()
    for (const item of items()) {
      found.set(item.sender.id, item.sender.name)
      found.set(item.recipient.id, item.recipient.name)
    }
    return [...found].map(([id, name]) => ({ id, name }))
  })
  const visible = createMemo(() => {
    const term = query().trim().toLowerCase()
    return items().filter((item) => {
      if (phase() !== "all" && item.state !== phase()) return false
      if (worker() !== "all" && item.sender.id !== worker() && item.recipient.id !== worker()) return false
      if (!term) return true
      return [item.objective, item.response, item.reason, ...(item.artifacts ?? []).map((file) => file.path)].some(
        (value) => value?.toLowerCase().includes(term),
      )
    })
  })
  const clear = () => {
    setQuery("")
    setPhase("all")
    setWorker("all")
  }

  createEffect(() => {
    props.id
    clear()
  })

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
    setTrace({ request, id: item.id, agent: item.sender.id, action: "inspect" })
    vscode.postMessage({
      type: "routineDelegateChain",
      requestID: request,
      agentID: item.sender.id,
      id: item.id,
    })
  }

  const follow = (item: Work) => {
    if (trace()) return
    const saved = trees()[item.id]
    if (saved) {
      assign(parent(item, saved))
      return
    }
    const request = crypto.randomUUID()
    setTrace({ request, id: item.id, agent: item.sender.id, action: "follow" })
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

  return (
    <section class="routines-organization-work" aria-labelledby={`organization-work-${props.id}`}>
      <div class="routines-organization-work-head">
        <div>
          <h3 id={`organization-work-${props.id}`}>Work</h3>
          <Show when={summary()}>
            {(total) => (
              <div class="routines-organization-work-summary" aria-label="Organization work totals">
                <p>
                  {total().active} active
                  {total().needsAttention ? ` · ${total().needsAttention} need attention` : ""}
                  {` · ${total().total} ${total().total === 1 ? "request" : "requests"}`}
                </p>
                <p>
                  <span>{money(total().recordedCost)} spent</span>
                  <span title="Committed cost includes recorded spend and live work reserved at its saved budget limit.">
                    {money(total().committedCost)} committed
                  </span>
                  <Show when={props.item.budget !== undefined}>
                    <span>
                      {money(Math.max((props.item.budget ?? 0) - total().committedCost, 0))} available of{" "}
                      {money(props.item.budget ?? 0)}
                    </span>
                  </Show>
                  <Show when={total().uncertain}>
                    {(count) => (
                      <span>
                        {count()} cost {count() === 1 ? "receipt" : "receipts"} pending
                      </span>
                    )}
                  </Show>
                </p>
              </div>
            )}
          </Show>
        </div>
        <div class="routines-organization-work-actions">
          <Button size="small" onClick={() => assign()}>
            Assign work
          </Button>
          <Button variant="ghost" size="small" disabled={busy()} onClick={() => load()}>
            Refresh work
          </Button>
        </div>
      </div>
      <Show when={props.receipt}>
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
        <div class="routines-organization-work-filters" aria-label="Filter work">
          <label class="routines-field">
            Search work
            <input
              type="search"
              value={query()}
              placeholder="Outcome or report"
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <label class="routines-field">
            State
            <select value={phase()} onChange={(event) => setPhase(event.currentTarget.value)}>
              <option value="all">All states</option>
              <For each={[...states]}>{(state) => <option value={state}>{label(state)}</option>}</For>
            </select>
          </label>
          <label class="routines-field">
            Worker
            <select value={worker()} onChange={(event) => setWorker(event.currentTarget.value)}>
              <option value="all">All workers</option>
              <For each={workers()}>{(person) => <option value={person.id}>{person.name}</option>}</For>
            </select>
          </label>
          <Show when={query() || phase() !== "all" || worker() !== "all"}>
            <Button variant="ghost" size="small" onClick={clear}>
              Clear filters
            </Button>
          </Show>
        </div>
        <p class="routines-organization-work-count" role="status">
          Showing {visible().length} of {items().length} loaded
        </p>
      </Show>
      <Show when={visible().length}>
        <ol class="routines-organization-work-list">
          <For each={visible()}>
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
                <ArtifactList items={item.artifacts} />
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
                  <Show when={item.state === "completed"}>
                    <Button variant="ghost" size="small" disabled={!!trace()} onClick={() => follow(item)}>
                      {trace()?.id === item.id && trace()?.action === "follow" ? "Loading routes" : "Assign follow-on"}
                    </Button>
                  </Show>
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
                      <Button intent="quiet" scale="compact" disabled={!!stopping()} onClick={() => setConfirm("")}>
                        Keep running
                      </Button>
                      <Button
                        intent="destructive"
                        scale="compact"
                        disabled={!!stopping() && stopping()?.id !== item.id}
                        pending={stopping()?.id === item.id}
                        onClick={() => stop(item)}
                      >
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
      <Show when={items().length && !visible().length}>
        <p class="routines-empty">No work matches these filters.</p>
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
