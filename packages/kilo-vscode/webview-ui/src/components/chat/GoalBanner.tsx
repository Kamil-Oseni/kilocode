// raya_change - Milestone A persistent goal banner and controls
import { Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import type { GoalState } from "../../../../src/shared/goal"

export const GoalBanner: Component = () => {
  const session = useSession()
  const vscode = useVSCode()
  const [goal, setGoal] = createSignal<GoalState>()
  const [notice, setNotice] = createSignal<string>()
  const sid = () => session.currentSessionID()

  createEffect(() => {
    const id = sid()
    setGoal(undefined)
    setNotice(undefined)
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

  const act = (action: "pause" | "resume" | "clear") => {
    const id = sid()
    if (id) vscode.postMessage({ type: "goalControl", sessionID: id, action })
  }

  const latest = () => goal()?.progress.at(-1)?.message

  return (
    <Show when={goal() || notice()}>
      <section class="goal-banner" classList={{ "goal-banner--blocked": goal()?.status === "blocked" }}>
        <Show when={notice()}>
          {(text) => (
            <div class="goal-banner__notice">
              <span>{text()}</span>
              <button type="button" aria-label="Dismiss goal notice" onClick={() => setNotice(undefined)}>
                ×
              </button>
            </div>
          )}
        </Show>
        <Show when={goal()}>
          {(state) => (
            <>
              <div class="goal-banner__header">
                <strong>Goal · {state().status}</strong>
                <span>
                  {state().usage.turns} turns · {state().usage.continuations} continuations · {state().usage.toolCalls}{" "}
                  tool calls
                </span>
              </div>
              <div class="goal-banner__objective">{state().objective}</div>
              <Show when={state().blockedReason}>
                {(reason) => <div class="goal-banner__reason">Blocked: {reason()}</div>}
              </Show>
              <Show when={latest()}>{(line) => <div class="goal-banner__progress">{line()}</div>}</Show>
              <div class="goal-banner__actions">
                <Show when={state().status === "active"}>
                  <Button size="small" variant="secondary" onClick={() => act("pause")}>
                    Pause
                  </Button>
                </Show>
                <Show when={state().status === "paused"}>
                  <Button size="small" variant="secondary" onClick={() => act("resume")}>
                    Resume
                  </Button>
                </Show>
                <Button size="small" variant="secondary" onClick={() => act("clear")}>
                  Clear
                </Button>
              </div>
            </>
          )}
        </Show>
      </section>
    </Show>
  )
}
