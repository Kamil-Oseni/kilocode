// raya_change - Milestone A persistent goal banner and controls
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon" // raya_change - self-redesign status icons
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import type { GoalState, GoalStatus } from "../../../../src/shared/goal"
import type { GoalEditedMessage, GoalStoppedMessage, TodoItem } from "../../types/messages"
import { GoalAudit } from "./GoalAudit"
import { GoalCriteria } from "./GoalCriteria"
import { GoalRevisions } from "./GoalRevisions"
import { GoalReview } from "./GoalReview"
import { GoalReport } from "./GoalReport"
import { GoalPlan } from "./GoalPlan"
import { GoalCriteriaEditor } from "./GoalCriteriaEditor"
import { valid, equal } from "../../../../src/shared/goal-criteria"

// raya_change start - self-redesign: presentational goal banner. Split from the
// connected wrapper below so it renders from props alone (mock data in the dev
// preview, live goal state in the webview).
const statusWord: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  complete: "Complete",
  blocked: "Blocked",
}

const steering: Record<GoalStatus, string> = {
  active: "Any running work may finish. Your revision applies to the next step.",
  paused: "The goal stays paused after this update. Resume it when you are ready to continue.",
  blocked: "Raya will resume from this revision.",
  complete: "Completed goals cannot be revised. Start a new goal for further work.",
}

export interface GoalBannerProps {
  sessionID?: string
  goal?: GoalState
  notice?: string
  todos?: TodoItem[]
  disabled?: boolean
  expanded?: boolean
  editing?: boolean
  saving?: boolean
  editError?: string
  confirmingStop?: boolean
  stopError?: string
  /** Design-preview only: statically render the hover, focus, or pressed state. */
  pv?: "hover" | "focus" | "active"
  onToggle?: () => void
  onEdit?: () => void
  onCancelEdit?: () => void
  onAccept?: () => void
  onRevise?: (objective: string, expectedIntent: string, criteria?: GoalState["criteria"]) => void
  onStop?: () => void
  onCancelStop?: () => void
  onPause?: () => void
  onResume?: () => void
  onClear?: () => void
  onDismissNotice?: () => void
}

// raya_change - avoid "1 turns"; pluralize the metric label off its count
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

function label(goal: Pick<GoalState, "status" | "review">) {
  return goal.status === "paused" && goal.review?.status === "pending" ? "Ready for review" : statusWord[goal.status]
}

export const GoalBannerView: Component<GoalBannerProps> = (props) => {
  const [page, setPage] = createSignal(0)
  const identity = createMemo(() => props.goal?.createdAt)
  const pages = () => {
    const current = props.goal
    if (!current) return []
    return [current, ...(current.history ?? []).toReversed()]
  }
  createEffect(on(identity, () => setPage(0)))
  const viewing = () => pages()[page()] ?? props.goal
  const archive = () => page() > 0
  const editable = () => props.goal?.status !== "complete"
  const todos = () =>
    props.goal?.plan?.tasks.map((task) => ({ content: task.description, status: task.status })) ?? props.todos ?? []
  const planned = () => !archive() && !!todos().length
  const latest = () => (archive() ? undefined : props.goal?.progress.at(-1)?.message)
  const done = () => todos().filter((todo) => todo.status === "completed").length ?? 0
  const percent = () => {
    if (todos().length) return Math.round((done() / todos().length) * 100)
    return 0
  }
  const current = () => todos().filter((todo) => todo.status === "in_progress") ?? []
  const progress = () => {
    if (archive()) return
    if (props.goal?.status === "complete") return props.goal.audit?.summary ?? latest()
    if (props.goal?.plan && (props.goal.plan.review || props.goal.plan.objective !== props.goal.objective))
      return "The saved work plan needs review after the requirements changed."
    const tasks = current()
    if (!tasks.length) return latest()
    if (tasks.length === 1) return `Plan: ${tasks[0].content} is marked in progress.`
    return `Plan: ${tasks[0].content} and ${plural(tasks.length - 1, "other task")} are marked in progress.`
  }
  let editor: HTMLTextAreaElement | undefined
  let trigger: HTMLButtonElement | undefined
  const [draft, setDraft] = createSignal("")
  const [original, setOriginal] = createSignal("")
  const [basis, setBasis] = createSignal("unset")
  const [criteria, setCriteria] = createSignal<NonNullable<GoalState["criteria"]>>([])
  const [saved, setSaved] = createSignal<GoalState["criteria"]>()
  const required = () => (!criteria().length && saved() === undefined ? undefined : criteria())
  const revised = () => !equal(required(), saved())
  const invalid = () => revised() && !valid(required())
  const [now, setNow] = createSignal(Date.now())
  const runtime = () => {
    const goal = props.goal
    if (!goal) return 0
    if (goal.activeMs === undefined) {
      const end = goal.status === "active" ? now() : goal.updatedAt
      return Math.max(0, end - goal.createdAt)
    }
    return goal.activeMs + (goal.status === "active" ? Math.max(0, now() - (goal.activeAt ?? goal.updatedAt)) : 0)
  }
  const duration = () => {
    const seconds = Math.floor(runtime() / 1000)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const rest = seconds % 60
    if (hours) return `${hours}h ${minutes}m`
    if (minutes) return `${minutes}m ${rest}s`
    return `${rest}s`
  }

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  }) // raya_change - keep elapsed goal time current without backend polling

  // raya_change start - seed steering once when editing opens. Goal progress
  // refreshes must never overwrite text while the user is typing.
  createEffect(
    on(
      () => props.editing,
      (editing, before) => {
        if (!editing) {
          if (before)
            queueMicrotask(() => {
              if (!props.editing && trigger?.isConnected) trigger.focus()
            })
          return
        }
        if (!props.goal) return
        setDraft(props.goal.objective)
        setOriginal(props.goal.objective.trim())
        setBasis(props.goal.intent ?? "unset")
        setSaved(props.goal.criteria?.map((item) => ({ ...item })))
        setCriteria(props.goal.criteria?.map((item) => ({ ...item })) ?? [])
        queueMicrotask(() => editor?.focus())
      },
    ),
  )
  // raya_change end

  const disabled = () =>
    props.disabled ||
    !editable() ||
    props.saving ||
    !!props.editError ||
    !draft().trim() ||
    (draft().trim() === original() && !revised()) ||
    invalid()
  const submit = () => {
    const objective = draft().trim()
    if (
      objective &&
      (objective !== original() || revised()) &&
      !invalid() &&
      !props.disabled &&
      !props.saving &&
      !props.editError
    )
      props.onRevise?.(objective, basis(), revised() ? required() : undefined)
  }

  return (
    <Show when={props.goal || props.notice}>
      <section
        classList={{ "goal-banner": true, "goal-banner--disabled": !!props.disabled }}
        data-status={(viewing() ?? props.goal)?.status ?? "notice"}
        data-pv={props.pv}
        aria-label="Goal status"
        aria-busy={props.saving || props.disabled}
      >
        <Show when={props.notice}>
          {(text) => (
            <div class="goal-banner__notice">
              <span>{text()}</span>
              <button
                type="button"
                class="goal-banner__notice-dismiss"
                aria-label="Dismiss goal notice"
                onClick={() => props.onDismissNotice?.()}
              >
                <Icon name="close-small" size="small" />
              </button>
            </div>
          )}
        </Show>
        <Show when={props.goal}>
          {(state) => (
            <>
              <div class="goal-banner__header">
                {/* raya_change - one typographic voice: "Goal <status>" both in
                    Instrument Serif, no per-status icons (they were inconsistent
                    across states). Status color carries the meaning. */}
                <span class="goal-banner__status">
                  <span class="goal-banner__label">Goal</span>
                  <span class="goal-banner__status-word">{label(viewing() ?? state())}</span>
                </span>
                <Show when={pages().length > 1}>
                  <span class="goal-banner__pages">
                    <button
                      type="button"
                      class="goal-banner__page"
                      disabled={page() >= pages().length - 1}
                      aria-label="Previous goal"
                      onClick={() => setPage((n) => Math.min(n + 1, pages().length - 1))}
                    >
                      <Icon name="arrow-left" size="small" />
                    </button>
                    <span>
                      {page() + 1}/{pages().length}
                    </span>
                    <button
                      type="button"
                      class="goal-banner__page"
                      disabled={page() === 0}
                      aria-label="Next goal"
                      onClick={() => setPage((n) => Math.max(n - 1, 0))}
                    >
                      <Icon name="arrow-right" size="small" />
                    </button>
                  </span>
                </Show>
                <Show when={!archive()}>
                  <span class="goal-banner__usage">
                    {duration()} ·{" "}
                    <Show when={todos().length}>
                      Plan: {percent()}% ({done()}/{todos().length} tasks completed) ·{" "}
                    </Show>
                    {plural(state().usage.turns, "turn")} · {plural(state().usage.toolCalls, "tool")}
                  </span>
                </Show>
                <button
                  type="button"
                  class="goal-banner__toggle"
                  onClick={() => props.onToggle?.()}
                  aria-expanded={props.expanded}
                  aria-label={props.expanded ? "Collapse goal details" : "Expand goal details"}
                >
                  <Icon name="chevron-down" size="small" />
                </button>
              </div>
              {/* raya_change - a hairline progress track gives the one reserved
                  warm accent its intended home: the persistent goal's progress.
                  Terminal states adopt the status color so the fill agrees with
                  the status word. */}
              <Show when={planned()}>
                <div
                  class="goal-banner__track"
                  role="progressbar"
                  aria-label="Plan task completion"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent()}
                  aria-valuetext={`${done()} of ${todos().length} plan tasks completed. Goal acceptance is checked separately.`}
                >
                  <span class="goal-banner__track-fill" style={{ width: `${percent()}%` }} />
                </div>
              </Show>
              <div class="goal-banner__summary">
                <div class="goal-banner__objective" data-expanded={props.expanded ? "" : undefined}>
                  {(viewing() ?? state()).objective}
                </div>
                <Show when={progress()}>
                  {(line) => (
                    <div class="goal-banner__progress" role="status">
                      {line()}
                    </div>
                  )}
                </Show>
              </div>
              <Show when={props.expanded && archive()}>
                <div class="goal-banner__details">
                  <GoalReview review={viewing()!.review} historical />
                  <GoalAudit goal={viewing()!} sessionID={props.sessionID} empty />
                  <GoalCriteria criteria={viewing()!.criteria} />
                  <GoalRevisions goal={viewing()!} sessionID={props.sessionID} />
                  <GoalPlan goal={viewing()!} />
                  <GoalReport goal={viewing()!} sessionID={props.sessionID} />
                </div>
              </Show>
              <Show when={props.expanded && !archive()}>
                <div class="goal-banner__details">
                  <Show when={state().dispatch}>
                    {(dispatch) => (
                      <div class="goal-banner__reason" role="status" aria-label="Latest goal execution">
                        {dispatch().phase === "queued"
                          ? "Latest continuation: queued. Execution has not been confirmed."
                          : dispatch().phase === "started"
                            ? "Latest continuation: handed to the runtime. Its outcome is not yet confirmed."
                            : dispatch().outcome === "error"
                              ? "Latest continuation: ended with an error. Review the conversation for details."
                              : dispatch().outcome === "interrupted"
                                ? "Latest continuation: interrupted. Review any changes and tool results before continuing."
                                : "Latest continuation: turn finished. Goal completion still depends on its acceptance checks."}
                      </div>
                    )}
                  </Show>
                  <Show when={state().blockedReason}>
                    {(reason) => <div class="goal-banner__reason">Blocked: {reason()}</div>}
                  </Show>
                  <GoalReview
                    review={state().review}
                    disabled={props.disabled || props.editing}
                    error={props.editError}
                    onAccept={state().status === "paused" ? props.onAccept : undefined}
                  />
                  <GoalAudit goal={state()} sessionID={props.sessionID} />
                  <GoalCriteria criteria={state().criteria} />
                  <GoalRevisions goal={state()} sessionID={props.sessionID} />
                  <GoalPlan goal={state()} />
                  <GoalReport goal={state()} sessionID={props.sessionID} />
                  <Show when={!state().plan && todos().length}>
                    <div class="goal-banner__tasks" aria-label="Goal tasks">
                      <div class="goal-banner__section-title">Work plan</div>
                      <For each={props.todos}>
                        {(todo) => (
                          <div class="goal-banner__task" data-status={todo.status}>
                            <Icon name={todo.status === "completed" ? "circle-check" : "circle"} size="small" />
                            <span>
                              <span class="goal-banner__task-content">{todo.content}</span>
                              <span class="goal-banner__task-status">{todo.status.replaceAll("_", " ")}</span>
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="goal-banner__history" aria-label="Recent goal progress">
                    <div class="goal-banner__section-title">Recent activity</div>
                    <For each={state().progress.slice(-6).toReversed()}>
                      {(item) => (
                        <div class="goal-banner__history-item">
                          <span>
                            {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span>{item.message}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
                {/* raya_change - editor and stop-confirm live outside the scrollable
                    details region so their controls (Update goal, Stop goal) stay
                    reachable no matter how long the audit/history content grows. */}
                <Show when={props.editing}>
                  <div class="goal-banner__editor">
                    <label for="goal-objective-editor">Update the goal</label>
                    <textarea
                      id="goal-objective-editor"
                      ref={editor}
                      rows="6"
                      value={draft()}
                      readOnly={props.saving}
                      onInput={(event) => setDraft(event.currentTarget.value)}
                      aria-describedby="goal-objective-help"
                    />
                    <div id="goal-objective-help">
                      <p>{steering[state().status]}</p>
                      <p>
                        Changing the objective or acceptance criteria moves the current audit and attempt into earlier
                        requirements. They will not satisfy the revised goal. Verification must cover the revised
                        requirements.
                      </p>
                    </div>
                    <GoalCriteriaEditor
                      value={criteria()}
                      disabled={props.saving || props.disabled}
                      onChange={setCriteria}
                    />
                    <Show when={invalid()}>
                      <p role="status">Keep 1 to 20 criteria and fill in each description and verification method.</p>
                    </Show>
                    <Show when={props.editError}>
                      <div role="alert">{props.editError}</div>
                    </Show>
                    <div class="goal-banner__editor-actions">
                      <Button size="small" variant="secondary" onClick={submit} disabled={disabled()}>
                        {props.saving ? "Saving…" : "Update goal"}
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => props.onCancelEdit?.()}
                        disabled={props.disabled || props.saving}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </Show>
                <Show when={props.confirmingStop}>
                  <div class="goal-banner__discard" role="alert">
                    <span>Stop tracking this goal?</span>
                    <span class="goal-banner__discard-hint">
                      Already-running work may finish. Existing edits remain available from Review changes.
                    </span>
                    <div class="goal-banner__editor-actions">
                      <Show when={props.stopError}>
                        <span>{props.stopError}</span>
                      </Show>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={props.disabled || !!props.stopError}
                        onClick={() => props.onStop?.()}
                      >
                        Stop goal
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={props.disabled}
                        onClick={() => props.onCancelStop?.()}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </Show>
              </Show>
              {/* raya_change - the banner stays a quiet one-line status until the
                  chevron expands it; Steer and the run controls (Pause/Resume,
                  Stop/Dismiss) only appear in the expanded card so the collapsed
                  goal carries no button chrome. */}
              <Show when={props.expanded && !archive()}>
                <div class="goal-banner__actions">
                  <div class="goal-banner__actions-lead">
                    <Show when={editable()}>
                      <Button
                        ref={trigger}
                        size="small"
                        variant="secondary"
                        disabled={props.disabled || props.editing}
                        onClick={() => props.onEdit?.()}
                      >
                        Steer
                      </Button>
                    </Show>
                  </div>
                  <div class="goal-banner__actions-run">
                    <Show when={state().status === "active"}>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={props.disabled}
                        onClick={() => props.onPause?.()}
                      >
                        Pause
                      </Button>
                    </Show>
                    <Show when={state().status === "paused" || state().status === "blocked"}>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={props.disabled}
                        onClick={() => props.onResume?.()}
                      >
                        Resume
                      </Button>
                    </Show>
                    <Show when={state().status !== "complete"}>
                      <Button size="small" variant="ghost" disabled={props.disabled} onClick={() => props.onClear?.()}>
                        Stop goal
                      </Button>
                    </Show>
                    <Show when={state().status === "complete"}>
                      <Button size="small" variant="ghost" disabled={props.disabled} onClick={() => props.onClear?.()}>
                        Dismiss goal
                      </Button>
                    </Show>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>
      </section>
    </Show>
  )
}
// raya_change end

export const GoalBanner: Component = () => {
  const session = useSession()
  const vscode = useVSCode()
  const [goal, setGoal] = createSignal<GoalState>()
  const [notice, setNotice] = createSignal<string>()
  const [expanded, setExpanded] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [basis, setBasis] = createSignal<string>()
  const [clearing, setClearing] = createSignal<{ requestID: string; intent: string }>()
  const [stopError, setStopError] = createSignal<string>()
  let deadline: ReturnType<typeof setTimeout> | undefined
  const resetStop = () => {
    clearTimeout(deadline)
    setClearing(undefined)
  }
  const busy = () => !!pending() || !!clearing()
  const [pending, setPending] = createSignal<{
    requestID: string
    objective: string
    intent: string
    status?: "active" | "paused"
    criteria?: GoalState["criteria"]
    accept?: true
  }>()
  const [failure, setFailure] = createSignal<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = () => {
    clearTimeout(timer)
    setPending(undefined)
  }
  const sid = () => session.currentSessionID()
  const failed = (text: string, status?: "active" | "paused", accept?: true) => {
    if (status || accept) {
      setNotice(text)
      const id = sid()
      if (id) vscode.postMessage({ type: "goalGet", sessionID: id })
    }
    if (!status || editing())
      setFailure(status ? `${text} Copy your draft, then cancel and reopen before saving it.` : text)
  }

  createEffect(() => {
    const id = sid()
    setGoal(undefined)
    setNotice(undefined)
    setExpanded(false)
    setEditing(false)
    setStopping(false)
    setBasis(undefined)
    setStopError(undefined)
    resetStop()
    reset()
    setFailure(undefined)
    if (id) vscode.postMessage({ type: "goalGet", sessionID: id })
  })

  const consistent = (goal: GoalState, request: NonNullable<ReturnType<typeof pending>>) =>
    goal.objective === request.objective &&
    (request.criteria === undefined || equal(goal.criteria, request.criteria)) &&
    !!goal.intent &&
    (request.status === undefined || goal.status === request.status) &&
    (!request.accept || (goal.status === "complete" && goal.review?.status === "accepted"))

  const acknowledge = (message: GoalEditedMessage) => {
    if (message.sessionID !== sid()) return
    const request = pending()
    if (!request || message.requestID !== request.requestID) return
    reset()
    if (message.error || !message.goal || !consistent(message.goal, request)) {
      failed(message.error ?? "Could not confirm the requested goal change.", request.status, request.accept)
      return
    }
    const current = goal()?.intent ?? "unset"
    if (current !== request.intent && current !== message.goal.intent) {
      failed(
        "The goal changed while this update was being confirmed. Review the saved goal before trying again.",
        request.status,
        request.accept,
      )
      return
    }
    setGoal(message.goal)
    if (!request.status) setEditing(false)
    if (request.status && editing())
      setFailure("The goal's status changed. Copy your draft, then cancel and reopen before saving it.")
    setNotice(
      request.accept
        ? "Goal accepted."
        : request.status === "paused"
          ? "Goal paused."
          : request.status === "active"
            ? "Goal resumed."
            : "Goal updated.",
    )
  }

  const stopped = (message: GoalStoppedMessage) => {
    const request = clearing()
    if (message.sessionID !== sid() || !request || message.requestID !== request.requestID) return
    resetStop()
    const changed = goal() && (goal()?.intent ?? "unset") !== request.intent
    if (message.error || !message.cleared || changed) {
      const text =
        message.error ?? "The goal changed while stopping was confirmed. Cancel and review the refreshed goal."
      setStopError(text)
      setNotice(text)
    } else {
      setStopping(false)
      setBasis(undefined)
      setGoal(undefined)
      setNotice(
        (message.worker === "interrupted"
          ? "Goal tracking stopped and its worker was interrupted. External or background work may still finish."
          : message.worker === "preserved"
            ? "Goal tracking stopped. This request did not interrupt the parent worker."
            : "Goal tracking stopped. The worker's outcome is not confirmed.") +
          (message.background ? ` ${message.background}` : ""),
      )
    }
    const id = sid()
    if (id) vscode.postMessage({ type: "goalGet", sessionID: id })
  }

  onMount(() => {
    const off = vscode.onMessage((message) => {
      if (message.type === "goalStopResult") {
        if (message.sessionID === sid() && !goal() && !editing() && !stopping()) setNotice(message.notice)
        return
      }
      if (message.type === "goalStopped") {
        stopped(message)
        return
      }
      if (message.type === "goalEdited") {
        acknowledge(message)
        return
      }
      if (message.type !== "goalState" || message.sessionID !== sid()) return
      if (editing() && !message.goal) {
        setFailure("Raya could not read the current goal. Copy your draft before closing the editor.")
        reset()
        return
      }
      setGoal(message.goal)
      if (message.notice) setNotice(message.notice)
    })
    const show = (event: Event) => setNotice((event as CustomEvent<string>).detail)
    window.addEventListener("rayaGoalNotice", show)
    onCleanup(() => {
      clearTimeout(timer)
      resetStop()
      off()
      window.removeEventListener("rayaGoalNotice", show)
    })
  })

  const revise = (
    objective: string,
    expectedIntent: string,
    criteria?: GoalState["criteria"],
    status?: "active" | "paused",
    accept?: true,
  ) => {
    const sessionID = sid()
    if (!sessionID || busy() || (!status && !accept && failure())) return
    const requestID = crypto.randomUUID()
    setPending({ requestID, objective, intent: expectedIntent, status, criteria, accept })
    if (accept) setNotice("Checking evidence and recording acceptance...")
    if (status) setNotice(status === "paused" ? "Pausing goal…" : "Resuming goal…")
    timer = setTimeout(() => {
      if (pending()?.requestID !== requestID) return
      reset()
      failed(
        accept
          ? "Acceptance has not been confirmed and may still finish. Review the refreshed goal before trying again."
          : status
            ? "The status change has not been confirmed and may still finish. Review the refreshed goal before trying again."
            : "The update has not been confirmed and may still finish. Copy your draft, then cancel and reopen to review the saved goal.",
        status,
        accept,
      )
    }, 15_000)
    vscode.postMessage({ type: "goalEdit", sessionID, requestID, objective, expectedIntent, status, criteria, accept })
  }
  const transition = (status: "active" | "paused") => {
    const current = goal()
    if (!current || current.status === "complete" || current.status === status) return
    revise(current.objective, current.intent ?? "unset", undefined, status)
  }

  const stop = () => {
    const id = sid()
    const current = goal()
    if (!id || !current || busy() || stopError()) return
    const intent = basis() ?? current.intent ?? "unset"
    const requestID = crypto.randomUUID()
    setClearing({ requestID, intent })
    setNotice("Stopping goal tracking?")
    deadline = setTimeout(() => {
      if (clearing()?.requestID !== requestID) return
      resetStop()
      const text =
        "Stopping has not been confirmed and may still finish. Cancel and review the refreshed goal before trying again."
      setStopError(text)
      setNotice(text)
      vscode.postMessage({ type: "goalGet", sessionID: id })
    }, 15_000)
    vscode.postMessage({ type: "goalStop", sessionID: id, requestID, expectedIntent: intent })
  }

  return (
    <GoalBannerView
      sessionID={sid()}
      goal={goal()}
      notice={notice()}
      todos={session.todos()}
      expanded={expanded()}
      editing={editing()}
      disabled={busy()}
      stopError={stopError()}
      saving={!!pending() && pending()?.status === undefined}
      editError={failure()}
      confirmingStop={stopping()}
      onToggle={() => setExpanded((value) => !value)}
      onEdit={() => {
        if (busy() || editing()) return
        setFailure(undefined)
        setExpanded(true)
        setStopping(false)
        setEditing(true)
      }}
      onCancelEdit={() => {
        if (busy()) return
        setEditing(false)
        setFailure(undefined)
        const id = sid()
        if (id) vscode.postMessage({ type: "goalGet", sessionID: id })
      }}
      onAccept={() => {
        const current = goal()
        if (!current || busy() || current.status !== "paused" || current.review?.status !== "pending") return
        setFailure(undefined)
        revise(current.objective, current.intent ?? "unset", undefined, undefined, true)
      }}
      onRevise={revise}
      onStop={stop}
      onCancelStop={() => {
        if (busy()) return
        setStopping(false)
        setBasis(undefined)
        setStopError(undefined)
        const id = sid()
        if (id) vscode.postMessage({ type: "goalGet", sessionID: id })
      }}
      onPause={() => transition("paused")}
      onResume={() => transition("active")}
      onClear={() => {
        if (busy()) return
        setExpanded(true)
        setEditing(false)
        setBasis(goal()?.intent ?? "unset")
        setStopError(undefined)
        setStopping(true)
      }}
      onDismissNotice={() => setNotice(undefined)}
    />
  )
}
