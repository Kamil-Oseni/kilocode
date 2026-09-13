import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Component, For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"

type Organization = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationListResponse["items"][number]
type Agent = { id: string; name: string; enabled: boolean }
type Sent = {
  request: string
  source: string
  sender: string
  recipient: string
  objective: string
  expected?: string
  context?: string
  deadline?: number
  budget?: number
}

const states = new Set(["queued", "accepted", "running", "needs_input", "completed", "failed", "cancelled"])

function local(value: number) {
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function amount(value: string) {
  if (!value) return
  if (!/^\d+$/.test(value)) return Number.NaN
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 1_000_000 ? parsed : Number.NaN
}

function matches(value: unknown, pending: Sent, item: Organization) {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === "string" &&
    typeof row.state === "string" &&
    states.has(row.state) &&
    row.source === pending.source &&
    row.senderID === pending.sender &&
    row.recipientID === pending.recipient &&
    row.organizationID === item.id &&
    row.organizationRevision === item.revision &&
    row.objective === pending.objective &&
    row.expected === pending.expected &&
    row.context === pending.context &&
    row.deadline === pending.deadline &&
    row.budget === pending.budget
  )
}

export const OrganizationAssignment: Component<{
  item: Organization
  agents: Agent[]
  onEdit: () => void
  onAssigned: (worker: { id: string; name: string }) => void
}> = (props) => {
  const vscode = useVSCode()
  const dialog = useDialog()
  const uid = createUniqueId()
  const people = createMemo(() =>
    props.item.members.flatMap((member) => {
      const agent = props.agents.find((entry) => entry.id === member.agentID)
      return agent ? [{ agent, role: member.role }] : []
    }),
  )
  const targets = createMemo(() =>
    people().filter(
      (person) =>
        person.agent.enabled &&
        props.item.delegations.some(
          (edge) => edge.recipientID === person.agent.id && people().some((entry) => entry.agent.id === edge.senderID),
        ),
    ),
  )
  const [recipient, setRecipient] = createSignal(targets()[0]?.agent.id ?? "")
  const senders = createMemo(() => {
    const ids = new Set(
      props.item.delegations.filter((edge) => edge.recipientID === recipient()).map((edge) => edge.senderID),
    )
    return people().filter((person) => ids.has(person.agent.id))
  })
  const [sender, setSender] = createSignal(senders()[0]?.agent.id ?? "")
  const [objective, setObjective] = createSignal("")
  const [expected, setExpected] = createSignal("")
  const [context, setContext] = createSignal("")
  const [deadline, setDeadline] = createSignal("")
  const [budget, setBudget] = createSignal("")
  const [sent, setSent] = createSignal<Sent>()
  const [error, setError] = createSignal("")
  const source = `organization:${props.item.id}:${crypto.randomUUID()}`

  createEffect(() => {
    const available = senders()
    if (!available.some((person) => person.agent.id === sender())) setSender(available[0]?.agent.id ?? "")
  })

  const due = createMemo(() => (deadline() ? Date.parse(deadline()) : undefined))
  const cost = createMemo(() => amount(budget()))
  const valid = createMemo(
    () =>
      !!recipient() &&
      !!sender() &&
      !!objective().trim() &&
      objective().length <= 8000 &&
      (due() === undefined || (Number.isSafeInteger(due()) && due()! > Date.now())) &&
      (cost() === undefined || Number.isSafeInteger(cost())),
  )

  const receive = (msg: ExtensionMessage) => {
    if (msg.type !== "routineDelegated") return
    const pending = sent()
    if (!pending || msg.requestID !== pending.request || msg.agentID !== pending.sender) return
    if (msg.error) {
      setSent()
      setError(msg.error)
      return
    }
    if (!matches(msg.record, pending, props.item)) {
      setSent()
      setError("The assigned work response could not be verified. Refresh organization work before trying again.")
      return
    }
    const worker = people().find((person) => person.agent.id === pending.recipient)?.agent
    if (!worker) {
      setSent()
      setError("The responsible worker is no longer in this organization. Refresh before trying again.")
      return
    }
    props.onAssigned({ id: worker.id, name: worker.name })
    dialog.close()
  }

  const unsub = vscode.onMessage(receive)
  onCleanup(unsub)

  const submit = () => {
    if (!valid() || sent()) return
    const request = crypto.randomUUID()
    const value: Sent = {
      request,
      source,
      sender: sender(),
      recipient: recipient(),
      objective: objective().trim(),
      ...(expected().trim() ? { expected: expected().trim() } : {}),
      ...(context().trim() ? { context: context().trim() } : {}),
      ...(due() === undefined ? {} : { deadline: due()! }),
      ...(cost() === undefined ? {} : { budget: cost()! }),
    }
    setError("")
    setSent(value)
    vscode.postMessage({
      type: "routineDelegate",
      requestID: request,
      agentID: value.sender,
      recipientID: value.recipient,
      source: value.source,
      organizationID: props.item.id,
      organizationRevision: props.item.revision,
      objective: value.objective,
      ...(value.expected ? { expected: value.expected } : {}),
      ...(value.context ? { context: value.context } : {}),
      ...(value.deadline === undefined ? {} : { deadline: value.deadline }),
      ...(value.budget === undefined ? {} : { budget: value.budget }),
    })
  }

  return (
    <Dialog title={`Assign work in ${props.item.name}`} fit>
      <Show
        when={targets().length}
        fallback={
          <div class="routines-assignment">
            <p>No active worker has an authorized route. Resume a routed worker or update delegation permissions.</p>
            <div class="dialog-confirm-actions">
              <Button variant="secondary" size="large" onClick={() => dialog.close()} autofocus>
                Close
              </Button>
              <Button
                size="large"
                onClick={() => {
                  dialog.close()
                  queueMicrotask(props.onEdit)
                }}
              >
                Edit organization
              </Button>
            </div>
          </div>
        }
      >
        <form
          class="routines-assignment"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Show when={error()}>
            <p class="routines-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="routines-assignment-route">
            <label class="routines-field" for={`${uid}-recipient`}>
              Responsible worker
              <select
                id={`${uid}-recipient`}
                value={recipient()}
                disabled={!!sent()}
                autofocus
                onChange={(event) => setRecipient(event.currentTarget.value)}
              >
                <For each={targets()}>
                  {(person) => <option value={person.agent.id}>{person.agent.name + " · " + person.role}</option>}
                </For>
              </select>
            </label>
            <label class="routines-field" for={`${uid}-sender`}>
              Assigned by
              <select
                id={`${uid}-sender`}
                value={sender()}
                disabled={!!sent()}
                onChange={(event) => setSender(event.currentTarget.value)}
              >
                <For each={senders()}>
                  {(person) => <option value={person.agent.id}>{person.agent.name + " · " + person.role}</option>}
                </For>
              </select>
            </label>
          </div>
          <label class="routines-field" for={`${uid}-objective`}>
            Outcome
            <textarea
              id={`${uid}-objective`}
              value={objective()}
              maxlength={8000}
              rows={4}
              disabled={!!sent()}
              placeholder="What should this worker deliver?"
              onInput={(event) => setObjective(event.currentTarget.value)}
            />
          </label>
          <details class="routines-assignment-details">
            <summary>Details</summary>
            <label class="routines-field" for={`${uid}-expected`}>
              Expected result
              <textarea
                id={`${uid}-expected`}
                value={expected()}
                maxlength={8000}
                rows={2}
                disabled={!!sent()}
                onInput={(event) => setExpected(event.currentTarget.value)}
              />
            </label>
            <label class="routines-field" for={`${uid}-context`}>
              Context
              <textarea
                id={`${uid}-context`}
                value={context()}
                maxlength={8000}
                rows={3}
                disabled={!!sent()}
                onInput={(event) => setContext(event.currentTarget.value)}
              />
            </label>
            <div class="routines-assignment-route">
              <label class="routines-field" for={`${uid}-deadline`}>
                Deadline
                <input
                  id={`${uid}-deadline`}
                  type="datetime-local"
                  min={local(Date.now() + 60_000)}
                  value={deadline()}
                  disabled={!!sent()}
                  aria-invalid={deadline() !== "" && !(due()! > Date.now())}
                  onInput={(event) => setDeadline(event.currentTarget.value)}
                />
              </label>
              <label class="routines-field" for={`${uid}-budget`}>
                Budget (USD)
                <input
                  id={`${uid}-budget`}
                  type="number"
                  min="0"
                  max="1000000"
                  step="1"
                  value={budget()}
                  disabled={!!sent()}
                  aria-invalid={budget() !== "" && !Number.isSafeInteger(cost())}
                  onInput={(event) => setBudget(event.currentTarget.value)}
                />
              </label>
            </div>
          </details>
          <div class="dialog-confirm-actions">
            <Button variant="secondary" size="large" disabled={!!sent()} onClick={() => dialog.close()}>
              Cancel
            </Button>
            <Button type="submit" size="large" disabled={!valid() || !!sent()}>
              {sent() ? "Assigning" : "Assign work"}
            </Button>
          </div>
        </form>
      </Show>
    </Dialog>
  )
}
