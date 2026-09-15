import { Button } from "@kilocode/kilo-ui/button"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { For, Show, createEffect, createMemo, createUniqueId, type Component } from "solid-js"

export type TodoProposalState = "open" | "pending" | "applied" | "rejected"
export type TodoProposalIssue = {
  kind: "offline" | "conflict" | "stale" | "uncertain" | "error"
  message: string
}
export type TodoProposalLink = {
  kind: "chat" | "routine" | "goal" | "session"
  id: string
}
export type TodoProposalSubtask = {
  id: string
  title: string
  status?: "open" | "completed"
  notes?: string | null
  priority?: "low" | "medium" | "high" | "urgent" | null
  estimateMinutes?: number | null
  dueAt?: number | null
  links?: readonly TodoProposalLink[] | null
}
export type TodoProposal = {
  id: string
  title: string
  detail?: string | null
  priority?: "low" | "medium" | "high" | "urgent" | null
  estimateMinutes?: number | null
  dueAt?: number | null
  reminderAt?: number | null
  links?: readonly TodoProposalLink[] | null
  subtasks?: readonly TodoProposalSubtask[]
}
export interface TodoProposalCardProps {
  proposal: TodoProposal
  state: TodoProposalState
  busy?: "apply" | "edit" | "reject"
  issue?: TodoProposalIssue
  disabled?: boolean
  decisionDisabled?: boolean
  onApply: () => void
  onEdit: () => void
  onReject: () => void
  onRetry?: () => void
}

type Related = TodoProposalLink & { task?: string }

const date = (value: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))

const label = (value: TodoProposalState) => {
  if (value === "pending") return "Application pending"
  if (value === "applied") return "Proposal applied"
  if (value === "rejected") return "Proposal rejected"
  return "Ready for review"
}

const detail = (value: TodoProposalState) => {
  if (value === "pending") return "This exact proposal is saved and ready to resume."
  if (value === "applied") return "These changes are now in your Todo list."
  if (value === "rejected") return "This proposal won't change your Todo list."
  return "Review the details before you decide."
}

const activity = (value: NonNullable<TodoProposalCardProps["busy"]>) => {
  if (value === "apply") return "Applying proposal"
  if (value === "edit") return "Opening proposal editor"
  return "Rejecting proposal"
}

const activityDetail = (value: NonNullable<TodoProposalCardProps["busy"]>) => {
  if (value === "apply") return "Raya is saving this exact proposal."
  if (value === "edit") return "Your reviewed proposal will remain unchanged until you save the edit."
  return "Raya is recording your decision."
}

const issue = (value: TodoProposalIssue["kind"]) => {
  if (value === "offline") return "You're offline"
  if (value === "conflict") return "Proposal conflict"
  if (value === "stale") return "Proposal is out of date"
  if (value === "uncertain") return "Result is uncertain"
  return "Proposal error"
}

export const TodoProposalCard: Component<TodoProposalCardProps> = (props) => {
  const title = `todo-proposal-${createUniqueId()}`
  let root: HTMLElement | undefined
  let status: HTMLDivElement | undefined
  let mounted = false
  const pending = createMemo(() => props.busy !== undefined)
  const locked = createMemo(() => props.disabled || pending())
  const decisionLocked = createMemo(() => locked() || props.decisionDisabled || props.state !== "open")
  const message = createMemo(
    () => props.issue?.message ?? (props.busy ? activityDetail(props.busy) : detail(props.state)),
  )
  const urgent = createMemo(() => ["conflict", "stale", "error"].includes(props.issue?.kind ?? ""))
  const links = createMemo<readonly Related[]>(() => [
    ...(props.proposal.links ?? []).map((link) => ({ ...link, task: undefined })),
    ...(props.proposal.subtasks ?? []).flatMap((task) =>
      (task.links ?? []).map((link) => ({ ...link, task: task.title })),
    ),
  ])

  createEffect(() => {
    props.state
    props.issue?.kind
    props.busy
    if (!mounted) {
      mounted = true
      return
    }
    const active = document.activeElement
    queueMicrotask(() => {
      if (active instanceof HTMLElement && !active.isConnected && root?.isConnected) status?.focus()
    })
  })

  return (
    <section
      ref={root}
      data-component="todo-proposal-card"
      data-state={props.state}
      data-issue={props.issue?.kind}
      aria-labelledby={title}
      aria-busy={pending()}
    >
      <header data-slot="todo-proposal-header">
        <div>
          <span data-slot="todo-proposal-eyebrow">Todo proposal</span>
          <h3 id={title} dir="auto">
            {props.proposal.title}
          </h3>
        </div>
        <span data-slot="todo-proposal-state">{label(props.state)}</span>
      </header>

      <Show when={props.proposal.detail}>
        {(value) => (
          <p data-slot="todo-proposal-detail" dir="auto">
            {value()}
          </p>
        )}
      </Show>

      <Show
        when={
          props.proposal.priority ||
          props.proposal.estimateMinutes ||
          props.proposal.dueAt !== undefined ||
          props.proposal.reminderAt !== undefined
        }
      >
        <dl data-slot="todo-proposal-metadata">
          <Show when={props.proposal.priority}>
            {(value) => (
              <div>
                <dt>Priority</dt>
                <dd>{value()}</dd>
              </div>
            )}
          </Show>
          <Show when={props.proposal.estimateMinutes}>
            {(value) => (
              <div>
                <dt>Estimate</dt>
                <dd>{value()} min</dd>
              </div>
            )}
          </Show>
          <Show
            when={
              props.proposal.dueAt !== null && props.proposal.dueAt !== undefined
                ? { value: props.proposal.dueAt }
                : undefined
            }
          >
            {(stamp) => (
              <div>
                <dt>Due</dt>
                <dd>
                  <time dateTime={new Date(stamp().value).toISOString()}>{date(stamp().value)}</time>
                </dd>
              </div>
            )}
          </Show>
          <Show
            when={
              props.proposal.reminderAt !== null && props.proposal.reminderAt !== undefined
                ? { value: props.proposal.reminderAt }
                : undefined
            }
          >
            {(stamp) => (
              <div>
                <dt>Reminder</dt>
                <dd>
                  <time dateTime={new Date(stamp().value).toISOString()}>{date(stamp().value)}</time>
                </dd>
              </div>
            )}
          </Show>
        </dl>
      </Show>

      <Show when={props.proposal.subtasks?.length}>
        <div data-slot="todo-proposal-subtasks">
          <h4>Subtasks</h4>
          <ol>
            <For each={props.proposal.subtasks}>
              {(item) => (
                <li data-status={item.status ?? "open"}>
                  <span dir="auto">{item.title}</span>
                  <Show when={item.notes}>{(value) => <p dir="auto">{value()}</p>}</Show>
                  <Show when={item.priority || item.estimateMinutes || item.dueAt !== undefined}>
                    <span data-slot="todo-proposal-subtask-meta">
                      <Show when={item.priority}>{(value) => <span>{value()} priority</span>}</Show>
                      <Show when={item.estimateMinutes}>{(value) => <span>{value()} min</span>}</Show>
                      <Show when={item.dueAt !== null && item.dueAt !== undefined ? { value: item.dueAt } : undefined}>
                        {(stamp) => (
                          <time dateTime={new Date(stamp().value).toISOString()}>Due {date(stamp().value)}</time>
                        )}
                      </Show>
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </div>
      </Show>

      <Show when={links().length}>
        <div data-slot="todo-proposal-related">
          <h4>Related</h4>
          <ul>
            <For each={links()}>
              {(link) => (
                <li>
                  <Show when={link.task}>{(task) => <span dir="auto">{task()}: </span>}</Show>
                  <span>{link.kind}</span> <code>{link.id}</code>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <div
        ref={status}
        data-slot="todo-proposal-status"
        data-kind={props.issue?.kind ?? props.state}
        role={urgent() ? "alert" : "status"}
        aria-live={urgent() ? "assertive" : "polite"}
        tabIndex={-1}
      >
        <span data-slot="todo-proposal-status-copy">
          <Show when={pending()}>
            <span aria-hidden="true">
              <Spinner />
            </span>
          </Show>
          <span>
            <Show
              when={props.issue}
              fallback={<Show when={props.busy}>{(value) => <strong>{activity(value())}. </strong>}</Show>}
            >
              {(value) => <strong>{issue(value().kind)}. </strong>}
            </Show>
            {message()}
          </span>
        </span>
        <Show when={props.onRetry && (props.issue || props.state === "pending")}>
          <Button size="small" variant="secondary" disabled={pending()} onClick={() => props.onRetry?.()}>
            {props.state === "pending" && !props.issue ? "Continue applying" : "Try again"}
          </Button>
        </Show>
      </div>

      <Show when={props.state === "open"}>
        <div data-slot="todo-proposal-actions">
          <Button size="small" variant="primary" disabled={decisionLocked()} onClick={() => props.onApply()}>
            Apply
          </Button>
          <Button size="small" variant="secondary" disabled={locked()} onClick={() => props.onEdit()}>
            Edit
          </Button>
          <Button size="small" variant="ghost" disabled={decisionLocked()} onClick={() => props.onReject()}>
            Reject
          </Button>
        </div>
      </Show>
    </section>
  )
}
