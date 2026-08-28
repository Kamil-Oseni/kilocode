// raya_change - Milestone A persistent goal banner and controls
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
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
  confirmingDiscard?: boolean
  discardDisabled?: boolean
  discardHint?: string
  /** Design-preview only: statically render the hover, focus, or pressed state. */
  pv?: "hover" | "focus" | "active"
  onToggle?: () => void
  onEdit?: () => void
  onCancelEdit?: () => void
  onRevise?: (objective: string) => void
  onReview?: () => void
  onKeep?: () => void
  onDiscard?: () => void
  onCancelDiscard?: () => void
  onPause?: () => void
  onResume?: () => void
  onClear?: () => void
  onDismissNotice?: () => void
}

export const GoalBannerView: Component<GoalBannerProps> = (props) => {
  const latest = () => props.goal?.progress.at(-1)?.message
  const done = () => props.todos?.filter((todo) => todo.status === "completed").length ?? 0
  const current = () => props.todos?.find((todo) => todo.status === "in_progress")
  const progress = () => {
    const todo = current()
    return todo ? `Now: ${todo.content}` : latest()
  }
  let editor: HTMLTextAreaElement | undefined

  createEffect(() => {
    if (!props.editing || !editor || !props.goal) return
    editor.value = props.goal.objective
    queueMicrotask(() => editor?.focus())
  })

  const submit = () => {
    const objective = editor?.value.trim()
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
                <span class="goal-banner__status">
                  <Show when={state().status === "complete" || state().status === "blocked"}>
                    <Icon name={state().status === "complete" ? "circle-check" : "circle-ban-sign"} size="small" />
                  </Show>
                  <span class="goal-banner__label">Goal</span>
                  <span class="goal-banner__status-word">{statusWord[state().status]}</span>
                </span>
                <span class="goal-banner__usage">
                  <Show when={props.todos?.length}>
                    {done()}/{props.todos!.length} tasks ·{" "}
                  </Show>
                  {state().usage.turns} turns · {state().usage.toolCalls} tools
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
                        aria-describedby="goal-objective-help"
                      />
                      <div id="goal-objective-help">
                        The current step keeps running. Your revision applies to the next step.
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
                  <Show when={props.confirmingDiscard}>
                    <div class="goal-banner__discard" role="alert">
                      <span>Discard the workspace edits made since this goal began?</span>
                      <Show when={props.discardHint}>
                        {(hint) => <span class="goal-banner__discard-hint">{hint()}</span>}
                      </Show>
                      <div class="goal-banner__editor-actions">
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={props.discardDisabled}
                          onClick={() => props.onDiscard?.()}
                        >
                          Confirm discard
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => props.onCancelDiscard?.()}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>
              <div class="goal-banner__actions">
                <Button size="small" variant="ghost" onClick={() => props.onReview?.()}>
                  Review changes
                </Button>
                <Button size="small" variant="ghost" onClick={() => props.onEdit?.()}>
                  Steer
                </Button>
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
                <Show when={state().status !== "active"}>
                  <Button size="small" variant="secondary" disabled={props.disabled} onClick={() => props.onKeep?.()}>
                    Keep
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={props.disabled || props.discardDisabled}
                    onClick={() => props.onClear?.()}
                  >
                    Discard
                  </Button>
                </Show>
              </div>
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
  const [discarding, setDiscarding] = createSignal(false)
  const sid = () => session.currentSessionID()
  const start = () => goal()?.startMessageID
  const discardDisabled = () => session.status() !== "idle" || !start()
  const discardHint = () => {
    if (session.status() !== "idle") return "Pause the goal and wait for the current step to stop before discarding."
    if (!start()) return "This legacy goal has no safe starting checkpoint. Review changes and discard them manually."
    return undefined
  }

  createEffect(() => {
    const id = sid()
    setGoal(undefined)
    setNotice(undefined)
    setExpanded(false)
    setEditing(false)
    setDiscarding(false)
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

  const keep = () => act("clear")

  const discard = () => {
    const id = sid()
    const messageID = start()
    if (!id || !messageID || discardDisabled()) return
    vscode.postMessage({ type: "goalDiscard", sessionID: id, messageID })
    setDiscarding(false)
  }

  return (
    <GoalBannerView
      goal={goal()}
      notice={notice()}
      todos={session.todos()}
      expanded={expanded()}
      editing={editing()}
      confirmingDiscard={discarding()}
      discardDisabled={discardDisabled()}
      discardHint={discarding() ? discardHint() : undefined}
      onToggle={() => setExpanded((value) => !value)}
      onEdit={() => {
        setExpanded(true)
        setDiscarding(false)
        setEditing(true)
      }}
      onCancelEdit={() => setEditing(false)}
      onRevise={revise}
      onReview={() => vscode.postMessage({ type: "openChanges", turnId: start() })}
      onKeep={keep}
      onDiscard={discard}
      onCancelDiscard={() => setDiscarding(false)}
      onPause={() => act("pause")}
      onResume={() => act("resume")}
      onClear={() => {
        setExpanded(true)
        setEditing(false)
        setDiscarding(true)
      }}
      onDismissNotice={() => setNotice(undefined)}
    />
  )
}
