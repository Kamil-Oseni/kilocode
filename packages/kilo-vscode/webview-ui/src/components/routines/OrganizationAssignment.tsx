import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Component, For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { routineFailure } from "../../utils/routine-recovery"

type Organization = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationListResponse["items"][number]
type Agent = { id: string; name: string; enabled: boolean }
type Proposal = import("@kilocode/sdk/v2/client").KilocodeRoutineOrganizationProposalResponse
export type Follow = {
  id: string
  run?: string
  objective: string
  recipient: { id: string; name: string; role: string }
  used: string[]
  budget?: number
}
type Sent = {
  request: string
  source: string
  sender: string
  recipient: string
  objective: string
  parentID?: string
  parentRunID?: string
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
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : Number.NaN
}

function money(value: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value)
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
    row.parentID === pending.parentID &&
    row.parentRunID === pending.parentRunID &&
    row.organizationID === item.id &&
    row.organizationRevision === item.revision &&
    row.objective === pending.objective &&
    row.expected === pending.expected &&
    row.context === pending.context &&
    row.deadline === pending.deadline &&
    row.budget === pending.budget
  )
}

function prepared(value: unknown, item: Organization, people: { agent: Agent }[]): value is Proposal {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  if (row.organizationID !== item.id || row.revision !== item.revision) return false
  if (typeof row.senderID !== "string" || typeof row.recipientID !== "string") return false
  if (typeof row.objective !== "string" || typeof row.expected !== "string" || typeof row.context !== "string")
    return false
  if (!row.objective.trim() || !row.expected.trim()) return false
  if (row.objective.length > 8000 || row.expected.length > 8000 || row.context.length > 8000) return false
  if (!item.delegations.some((edge) => edge.senderID === row.senderID && edge.recipientID === row.recipientID))
    return false
  return (
    people.some((person) => person.agent.id === row.senderID && person.agent.enabled) &&
    people.some((person) => person.agent.id === row.recipientID && person.agent.enabled)
  )
}

const Review: Component<{
  sender: string
  recipient: string
  objective: string
  expected: string
  context: string
  limit?: number
  budget: string
  cost?: number
  error: string
  sent: boolean
  valid: boolean
  onBudget: (value: string) => void
  onRequest: () => void
  onEdit: () => void
  onSubmit: () => void
}> = (props) => (
  <div class="routines-assignment routines-assignment-review">
    <p class="routines-assignment-eyebrow">Ready for your review</p>
    <h3>
      {props.sender} assigns to {props.recipient}
    </h3>
    <div class="routines-assignment-review-content">
      <div>
        <span>Work</span>
        <p>{props.objective}</p>
      </div>
      <div>
        <span>Success looks like</span>
        <p>{props.expected}</p>
      </div>
      <Show when={props.context}>
        <div>
          <span>Helpful context</span>
          <p>{props.context}</p>
        </div>
      </Show>
      <Show when={props.limit !== undefined}>
        <Show
          when={props.limit! >= 1}
          fallback={
            <p class="routines-hint" role="status">
              No budget is available for this work. Increase the team's shared limit before assigning it.
            </p>
          }
        >
          <label class="routines-field">
            Maximum model cost (USD)
            <input
              type="number"
              min="1"
              max={props.limit!.toString()}
              step="1"
              value={props.budget}
              onInput={(event) => props.onBudget(event.currentTarget.value)}
            />
            <span class="routines-hint">
              This team has {money(props.limit!)} available. Choose a whole-dollar limit for this work.
            </span>
            <Show when={!Number.isSafeInteger(props.cost) || (props.cost ?? Infinity) > props.limit!}>
              <span class="routines-hint" role="status">
                Choose a limit within the team's available budget to assign this work.
              </span>
            </Show>
          </label>
        </Show>
      </Show>
    </div>
    <Show when={props.error}>
      <p class="routines-error" role="alert">
        {props.error}
      </p>
    </Show>
    <div class="dialog-confirm-actions">
      <Button variant="ghost" size="large" disabled={props.sent} onClick={props.onRequest}>
        Change request
      </Button>
      <Button variant="ghost" size="large" disabled={props.sent} onClick={props.onEdit}>
        Change details
      </Button>
      <Button size="large" disabled={!props.valid || props.sent} onClick={props.onSubmit}>
        {props.sent ? "Assigning" : "Assign work"}
      </Button>
    </div>
  </div>
)

const Simple: Component<{
  id: string
  intent: string
  planning: boolean
  error: string
  onField: (field: HTMLTextAreaElement) => void
  onInput: (value: string) => void
  onManual: () => void
  onPlan: () => void
}> = (props) => (
  <form
    class="routines-assignment routines-assignment-simple"
    onSubmit={(event) => {
      event.preventDefault()
      props.onPlan()
    }}
  >
    <div class="routines-assignment-intro">
      <h3>What needs to get done?</h3>
      <p>Say it naturally. Raya will prepare the route and result for you to review before anything starts.</p>
    </div>
    <label class="routines-field" for={`${props.id}-intent`}>
      <span class="sr-only">Describe the work</span>
      <textarea
        ref={props.onField}
        id={`${props.id}-intent`}
        value={props.intent}
        maxlength={8000}
        rows={5}
        autofocus
        placeholder="For example: Check that this organization and both workers still exist after restart, then send me a short confirmation."
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
    <Show when={props.error}>
      <p class="routines-error" role="alert">
        {props.error}
      </p>
    </Show>
    <div class="dialog-confirm-actions routines-assignment-simple-actions">
      <Button type="button" variant="ghost" size="large" onClick={props.onManual}>
        Choose details myself
      </Button>
      <Button type="submit" size="large" disabled={!props.intent.trim() || props.planning}>
        {props.planning ? "Preparing" : "Review plan"}
      </Button>
    </div>
  </form>
)

export const OrganizationAssignment: Component<{
  item: Organization
  agents: Agent[]
  parent?: Follow
  available?: number
  onChoose: (id: string) => void
  onPlan: (text: string) => void
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
    people().filter((person) => {
      if (!person.agent.enabled) return false
      if (props.parent)
        return (
          !props.parent.used.includes(person.agent.id) &&
          props.item.delegations.some(
            (edge) => edge.senderID === props.parent!.recipient.id && edge.recipientID === person.agent.id,
          )
        )
      return props.item.delegations.some(
        (edge) => edge.recipientID === person.agent.id && people().some((entry) => entry.agent.id === edge.senderID),
      )
    }),
  )
  const active = createMemo(() => people().filter((person) => person.agent.enabled))
  const name = (id: string) => people().find((person) => person.agent.id === id)?.agent.name ?? "Worker"
  const [recipient, setRecipient] = createSignal(targets()[0]?.agent.id ?? "")
  const senders = createMemo(() => {
    if (props.parent)
      return people().filter((person) => person.agent.enabled && person.agent.id === props.parent!.recipient.id)
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
  const [intent, setIntent] = createSignal("")
  const [manual, setManual] = createSignal(!!props.parent)
  const [planning, setPlanning] = createSignal("")
  const [review, setReview] = createSignal(false)
  const [reviewed, setReviewed] = createSignal<number>()
  const source = `organization${props.parent ? "-follow" : ""}:${props.item.id}:${crypto.randomUUID()}`
  let intentField: HTMLTextAreaElement | undefined
  let recipientField: HTMLSelectElement | undefined

  createEffect(() => {
    const available = senders()
    if (!available.some((person) => person.agent.id === sender())) setSender(available[0]?.agent.id ?? "")
  })

  const due = createMemo(() => (deadline() ? Date.parse(deadline()) : undefined))
  const cost = createMemo(() => amount(budget()))
  const ceiling = createMemo(() => (props.parent ? props.parent.budget : props.available))
  const bounded = createMemo(() => ceiling() !== undefined)
  const valid = createMemo(
    () =>
      !!recipient() &&
      !!sender() &&
      !!objective().trim() &&
      objective().length <= 8000 &&
      (due() === undefined || (Number.isSafeInteger(due()) && due()! > Date.now())) &&
      (bounded() ? Number.isSafeInteger(cost()) : cost() === undefined || Number.isSafeInteger(cost())) &&
      (ceiling() === undefined || (cost() ?? Number.POSITIVE_INFINITY) <= ceiling()!),
  )
  const fresh = () => reviewed() === props.item.revision
  const ready = () => valid() && fresh()

  createEffect(() => {
    if (!review() || fresh()) return
    setError("This team changed after the plan was prepared. Review a new plan before assigning work.")
  })

  const receive = (msg: ExtensionMessage) => {
    if (msg.type === "routineOrganizationProposal") {
      if (msg.requestID !== planning() || msg.organizationID !== props.item.id) return
      setPlanning("")
      const draft = msg.proposal
      if (msg.error || !draft) {
        setError(
          "Raya could not prepare a work plan. Your request is still here; try again or choose the details yourself.",
        )
        return
      }
      if (!prepared(draft, props.item, people())) {
        setError("The proposed route is no longer available. Refresh the team or choose the details yourself.")
        return
      }
      setRecipient(draft.recipientID)
      setSender(draft.senderID)
      setObjective(draft.objective)
      setExpected(draft.expected)
      setContext(draft.context)
      setError("")
      setReviewed(draft.revision)
      setReview(true)
      return
    }
    if (msg.type !== "routineDelegated") return
    const pending = sent()
    if (!pending || msg.requestID !== pending.request || msg.agentID !== pending.sender) return
    if (msg.error) {
      setSent()
      setError(routineFailure(msg.error, msg.recovery, "Your assignment draft is still here."))
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
    if (review() && !fresh()) return
    if (!valid() || sent()) return
    const request = crypto.randomUUID()
    const value: Sent = {
      request,
      source,
      sender: sender(),
      recipient: recipient(),
      objective: objective().trim(),
      ...(props.parent ? { parentID: props.parent.id } : {}),
      ...(props.parent?.run ? { parentRunID: props.parent.run } : {}),
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
      ...(value.parentID ? { parentID: value.parentID } : {}),
      ...(value.parentRunID ? { parentRunID: value.parentRunID } : {}),
      organizationID: props.item.id,
      organizationRevision: props.item.revision,
      objective: value.objective,
      ...(value.expected ? { expected: value.expected } : {}),
      ...(value.context ? { context: value.context } : {}),
      ...(value.deadline === undefined ? {} : { deadline: value.deadline }),
      ...(value.budget === undefined ? {} : { budget: value.budget }),
    })
  }

  const plan = () => {
    const text = intent().trim()
    if (!text || planning()) return
    const request = crypto.randomUUID()
    setPlanning(request)
    setError("")
    vscode.postMessage({
      type: "routineOrganizationProposal",
      requestID: request,
      organizationID: props.item.id,
      revision: props.item.revision,
      intent: text,
    })
  }

  return (
    <Dialog title={props.parent ? `Assign follow-on in ${props.item.name}` : `Give ${props.item.name} work`} fit>
      <Show
        when={targets().length}
        fallback={
          <div class="routines-assignment">
            <p>
              {props.parent
                ? `${props.parent.recipient.name} has no authorized route to an unused active worker.`
                : active().length === 1
                  ? `${active()[0]!.agent.name} is the only active worker. Message this worker directly for standalone work, or add another worker and choose a delegation direction for tracked organization work.`
                  : "Tracked organization work needs an explicit route between two active workers. Resume the required workers or edit who may assign work to whom."}
            </p>
            <div class="dialog-confirm-actions">
              <Button variant="secondary" size="large" onClick={() => dialog.close()} autofocus>
                Close
              </Button>
              <Show when={!props.parent && active().length === 1}>
                <Button
                  variant="secondary"
                  size="large"
                  onClick={() => {
                    const id = active()[0]!.agent.id
                    dialog.close()
                    queueMicrotask(() => props.onChoose(id))
                  }}
                >
                  Open worker chat
                </Button>
              </Show>
              <Button
                size="large"
                onClick={() => {
                  dialog.close()
                  queueMicrotask(() =>
                    props.onPlan(
                      `Help me make this team able to handle work. It currently has no active authorized route. Explain the smallest useful change in plain language and ask before changing the team.`,
                    ),
                  )
                }}
              >
                Ask Raya to fix this
              </Button>
            </div>
          </div>
        }
      >
        <Show
          when={manual()}
          fallback={
            <Show
              when={review()}
              fallback={
                <Simple
                  id={uid}
                  intent={intent()}
                  planning={!!planning()}
                  error={error()}
                  onField={(field) => {
                    intentField = field
                  }}
                  onInput={(value) => {
                    setIntent(value)
                    setPlanning("")
                  }}
                  onManual={() => {
                    setPlanning("")
                    setObjective(intent().trim())
                    setManual(true)
                    queueMicrotask(() => recipientField?.focus())
                  }}
                  onPlan={plan}
                />
              }
            >
              <Review
                sender={name(sender())}
                recipient={name(recipient())}
                objective={objective()}
                expected={expected()}
                context={context()}
                limit={ceiling()}
                budget={budget()}
                cost={cost()}
                error={error()}
                sent={!!sent()}
                valid={ready()}
                onBudget={setBudget}
                onRequest={() => {
                  setReview(false)
                  setError("")
                }}
                onEdit={() => {
                  setReview(false)
                  setError("")
                  setManual(true)
                  queueMicrotask(() => recipientField?.focus())
                }}
                onSubmit={submit}
              />
            </Show>
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
            <Show when={props.parent}>
              {(parent) => (
                <div class="routines-assignment-parent">
                  <span>Following</span>
                  <p>{parent().objective}</p>
                </div>
              )}
            </Show>
            <div class="routines-assignment-route">
              <label class="routines-field" for={`${uid}-recipient`}>
                Responsible worker
                <select
                  ref={recipientField}
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
              <Show
                when={props.parent}
                fallback={
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
                }
              >
                <div class="routines-field">
                  <span>Assigned by</span>
                  <strong class="routines-assignment-person">
                    {props.parent!.recipient.name + " · " + props.parent!.recipient.role}
                  </strong>
                </div>
              </Show>
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
            <Show when={bounded()}>
              <label class="routines-field" for={`${uid}-budget`}>
                Work budget (USD)
                <input
                  id={`${uid}-budget`}
                  type="number"
                  min="1"
                  max={ceiling()!.toString()}
                  step="1"
                  value={budget()}
                  disabled={!!sent()}
                  aria-invalid={!Number.isSafeInteger(cost()) || (cost() ?? Infinity) > ceiling()!}
                  onInput={(event) => setBudget(event.currentTarget.value)}
                />
                <span class="routines-hint">
                  {props.parent
                    ? `This follow-on must stay within its parent's ${money(ceiling()!)} budget.`
                    : `${money(ceiling()!)} remains available across organization work.`}
                </span>
              </label>
            </Show>
            <details class="routines-assignment-details">
              <summary>Optional details</summary>
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
                <Show when={!bounded()}>
                  <label class="routines-field" for={`${uid}-budget`}>
                    Optional budget (USD)
                    <input
                      id={`${uid}-budget`}
                      type="number"
                      min="1"
                      max="1000000"
                      step="1"
                      value={budget()}
                      disabled={!!sent()}
                      aria-invalid={budget() !== "" && !Number.isSafeInteger(cost())}
                      onInput={(event) => setBudget(event.currentTarget.value)}
                    />
                  </label>
                </Show>
              </div>
            </details>
            <div class="dialog-confirm-actions routines-assignment-manual-actions">
              <Button
                type="button"
                variant="ghost"
                size="large"
                disabled={!!sent()}
                onClick={() => {
                  setManual(false)
                  setReview(false)
                  queueMicrotask(() => intentField?.focus())
                }}
              >
                Let Raya choose
              </Button>
              <Button variant="secondary" size="large" disabled={!!sent()} onClick={() => dialog.close()}>
                Cancel
              </Button>
              <Button type="submit" size="large" disabled={!valid() || !!sent()}>
                {sent() ? "Assigning" : props.parent ? "Assign follow-on" : "Assign work"}
              </Button>
            </div>
          </form>
        </Show>
      </Show>
    </Dialog>
  )
}
