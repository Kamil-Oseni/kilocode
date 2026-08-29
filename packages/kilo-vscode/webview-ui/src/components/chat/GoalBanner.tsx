// raya_change - Milestone A persistent goal banner and controls
import { For, Show, createEffect, createSignal, on, onCleanup, onMount, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon" // raya_change - self-redesign status icons
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import type { GoalState, GoalStatus } from "../../../../src/shared/goal"
import type { TodoItem } from "../../types/messages"

// raya_change start - self-redesign: presentational goal banner. Split from the
// connected wrapper below so it renders from props alone (mock data in the dev
// preview, live goal state in the webview).
const statusWord: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  complete: "Complete",
  blocked: "Blocked",
}

export interface GoalBannerProps {
  goal?: GoalState
  notice?: string
  todos?: TodoItem[]
  disabled?: boolean
  expanded?: boolean
  editing?: boolean
  confirmingStop?: boolean
  /** Design-preview only: statically render the hover, focus, or pressed state. */
  pv?: "hover" | "focus" | "active"
  onToggle?: () => void
  onEdit?: () => void
  onCancelEdit?: () => void
  onRevise?: (objective: string) => void
  onStop?: () => void
  onCancelStop?: () => void
  onPause?: () => void
  onResume?: () => void
  onClear?: () => void
  onDismissNotice?: () => void
}

// raya_change - avoid "1 turns"; pluralize the metric label off its count
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

export const GoalBannerView: Component<GoalBannerProps> = (props) => {
  const latest = () => props.goal?.progress.at(-1)?.message
  const done = () => props.todos?.filter((todo) => todo.status === "completed").length ?? 0
  const percent = () => {
    if (props.todos?.length) return Math.round((done() / props.todos.length) * 100)
    return props.goal?.status === "complete" ? 100 : 0
  }
  const current = () => props.todos?.find((todo) => todo.status === "in_progress")
  const progress = () => {
    const todo = current()
    return todo ? `Now: ${todo.content}` : latest()
  }
  let editor: HTMLTextAreaElement | undefined
  const [draft, setDraft] = createSignal("")
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
      (editing) => {
        if (!editing || !props.goal) return
        setDraft(props.goal.objective)
        queueMicrotask(() => editor?.focus())
      },
    ),
  )
  // raya_change end

  const submit = () => {
    const objective = draft().trim()
    if (objective) props.onRevise?.(objective)
  }

  return (
    <Show when={props.goal || props.notice}>
      <section
        classList={{ "goal-banner": true, "goal-banner--disabled": !!props.disabled }}
        data-status={props.goal?.status ?? "notice"}
        data-pv={props.pv}
        aria-label="Goal status"
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
                  <span class="goal-banner__status-word">{statusWord[state().status]}</span>
                </span>
                <span class="goal-banner__usage">
                  {percent()}% · {duration()} ·{" "}
                  <Show when={props.todos?.length}>
                    {done()}/{props.todos!.length} tasks ·{" "}
                  </Show>
                  {plural(state().usage.turns, "turn")} · {plural(state().usage.toolCalls, "tool")}
                </span>
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
              <div class="goal-banner__track" aria-hidden="true">
                <span class="goal-banner__track-fill" style={{ width: `${percent()}%` }} />
              </div>
              <div class="goal-banner__summary">
                <div class="goal-banner__objective" data-expanded={props.expanded ? "" : undefined}>
                  {state().objective}
                </div>
                <Show when={progress()}>
                  {(line) => (
                    <div class="goal-banner__progress" role="status">
                      {line()}
                    </div>
                  )}
                </Show>
              </div>
              <Show when={props.expanded}>
                <div class="goal-banner__details">
                  <Show when={state().blockedReason}>
                    {(reason) => <div class="goal-banner__reason">Blocked: {reason()}</div>}
                  </Show>
                  {/* raya_change - goal audit log: for a stuck, blocked, or completed goal,
                      show the last completion attempt requirement-by-requirement with the
                      cited evidence and the exact rejection reason, instead of leaving that
                      detail buried in chat narration. */}
                  <Show when={state().auditAttempt}>
                    {(attempt) => (
                      <div class="goal-banner__audit" aria-label="Completion audit log">
                        <div class="goal-banner__section-title">
                          <span>Completion audit</span>
                          <span
                            class="goal-banner__audit-verdict"
                            data-accepted={attempt().accepted ? "" : undefined}
                          >
                            {attempt().accepted ? "Passed" : "Rejected"}
                          </span>
                        </div>
                        <Show when={!attempt().accepted && attempt().reason}>
                          {(reason) => <div class="goal-banner__audit-reason">{reason()}</div>}
                        </Show>
                        <For each={attempt().requirements}>
                          {(req) => (
                            <div class="goal-banner__audit-req" data-passed={req.passed ? "" : undefined}>
                              <div class="goal-banner__audit-req-head">
                                <Icon name={req.passed ? "circle-check" : "circle"} size="small" />
                                <span>{req.requirement}</span>
                              </div>
                              <For each={req.evidence}>
                                {(ev) => (
                                  <div class="goal-banner__audit-evidence">
                                    <code>{ev.callID}</code>
                                    <span>{ev.summary}</span>
                                  </div>
                                )}
                              </For>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                  <Show when={props.todos?.length}>
                    <div class="goal-banner__tasks" aria-label="Goal tasks">
                      <div class="goal-banner__section-title">Work plan</div>
                      <For each={props.todos}>
                        {(todo) => (
                          <div class="goal-banner__task" data-status={todo.status}>
                            <Icon name={todo.status === "completed" ? "circle-check" : "circle"} size="small" />
                            <span>{todo.content}</span>
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
                  <Show when={props.editing}>
                    <div class="goal-banner__editor">
                      <label for="goal-objective-editor">Update the goal</label>
                      <textarea
                        id="goal-objective-editor"
                        ref={editor}
                        rows="6"
                        value={draft()}
                        onInput={(event) => setDraft(event.currentTarget.value)}
                        aria-describedby="goal-objective-help"
                      />
                      <div id="goal-objective-help">
                        {state().status === "blocked"
                          ? "Raya will resume from this revision."
                          : "The current step keeps running. Your revision applies to the next step."}
                      </div>
                      <div class="goal-banner__editor-actions">
                        <Button size="small" variant="secondary" onClick={submit}>
                          Update goal
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => props.onCancelEdit?.()}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </Show>
                  <Show when={props.confirmingStop}>
                    <div class="goal-banner__discard" role="alert">
                      <span>Stop tracking this goal?</span>
                      <span class="goal-banner__discard-hint">
                        Existing edits will remain available from the chat-level Review changes action.
                      </span>
                      <div class="goal-banner__editor-actions">
                        <Button size="small" variant="secondary" onClick={() => props.onStop?.()}>
                          Stop goal
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => props.onCancelStop?.()}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
              {/* raya_change - the banner stays a quiet one-line status until the
                  chevron expands it; Steer and the run controls (Pause/Resume,
                  Stop/Dismiss) only appear in the expanded card so the collapsed
                  goal carries no button chrome. */}
              <Show when={props.expanded}>
              <div class="goal-banner__actions">
                <div class="goal-banner__actions-lead">
                  <Button size="small" variant="secondary" onClick={() => props.onEdit?.()}>
                    Steer
                  </Button>
                </div>
                <div class="goal-banner__actions-run">
                  <Show when={state().status === "active"}>
                    <Button size="small" variant="secondary" disabled={props.disabled} onClick={() => props.onPause?.()}>
                      Pause
                    </Button>
                  </Show>
                  <Show when={state().status === "paused"}>
                    <Button size="small" variant="secondary" disabled={props.disabled} onClick={() => props.onResume?.()}>
                      Resume
                    </Button>
                  </Show>
                  <Show when={state().status !== "complete"}>
                    <Button size="small" variant="ghost" onClick={() => props.onClear?.()}>
                      Stop goal
                    </Button>
                  </Show>
                  <Show when={state().status === "complete"}>
                    <Button size="small" variant="ghost" disabled={props.disabled} onClick={() => props.onStop?.()}>
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
  const sid = () => session.currentSessionID()

  createEffect(() => {
    const id = sid()
    setGoal(undefined)
    setNotice(undefined)
    setExpanded(false)
    setEditing(false)
    setStopping(false)
    if (id) vscode.postMessage({ type: "goalGet", sessionID: id })
  })

  onMount(() => {
    const off = vscode.onMessage((message) => {
      if (message.type !== "goalState" || message.sessionID !== sid()) return
      setGoal(message.goal)
      if (message.notice) setNotice(message.notice)
    })
    const show = (event: Event) => setNotice((event as CustomEvent<string>).detail)
    window.addEventListener("rayaGoalNotice", show)
    onCleanup(() => {
      off()
      window.removeEventListener("rayaGoalNotice", show)
    })
  })

  const act = (action: "pause" | "resume" | "clear" | "revise", objective?: string) => {
    const id = sid()
    if (id) vscode.postMessage({ type: "goalControl", sessionID: id, action, objective })
  }

  const revise = (objective: string) => {
    act("revise", objective)
    setEditing(false)
  }

  const stop = () => {
    act("clear")
    setStopping(false)
  } // raya_change - stopping goal tracking never accepts or discards session edits

  return (
    <GoalBannerView
      goal={goal()}
      notice={notice()}
      todos={session.todos()}
      expanded={expanded()}
      editing={editing()}
      confirmingStop={stopping()}
      onToggle={() => setExpanded((value) => !value)}
      onEdit={() => {
        setExpanded(true)
        setStopping(false)
        setEditing(true)
      }}
      onCancelEdit={() => setEditing(false)}
      onRevise={revise}
      onStop={stop}
      onCancelStop={() => setStopping(false)}
      onPause={() => act("pause")}
      onResume={() => act("resume")}
      onClear={() => {
        setExpanded(true)
        setEditing(false)
        setStopping(true)
      }}
      onDismissNotice={() => setNotice(undefined)}
    />
  )
}
