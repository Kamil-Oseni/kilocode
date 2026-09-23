import { For, Show, createMemo, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../../context/session"
import { agentIcon } from "./task-tool-state"
import { chiefActivity, type ChiefPart } from "./chief-activity"

const label = {
  planned: "Ready to start",
  working: "Working",
  ready: "Report ready",
  reviewed: "Reviewed",
  failed: "Needs attention",
  cancelled: "Stopped",
  unknown: "Status unknown",
} as const

export const ChiefActivity: Component<{ plan: ChiefPart }> = (props) => {
  const session = useSession()
  const activity = createMemo(() => {
    const id = session.currentSessionID()
    return id ? chiefActivity(props.plan, session.getSessionToolParts(id) as ChiefPart[]) : undefined
  })
  const summary = createMemo(() => {
    const current = activity()
    if (!current) return "Specialists"
    if (current.synthesized) return `${current.branches.length} specialist reports combined`
    const working = current.branches.filter((branch) => branch.state === "working").length
    if (working) return `${working} of ${current.branches.length} specialists working`
    const ready = current.branches.filter((branch) => branch.state === "ready" || branch.state === "reviewed").length
    if (ready === current.branches.length) return `${ready} specialist reports ready`
    const attention = current.branches.filter((branch) =>
      ["failed", "cancelled", "unknown"].includes(branch.state),
    ).length
    if (attention) return `${attention} specialist${attention === 1 ? " needs" : "s need"} attention`
    if (ready) return `${ready} of ${current.branches.length} specialist reports ready`
    return `${current.branches.length} specialists planned`
  })

  return (
    <Show when={activity()}>
      {(current) => (
        <details class="chief-activity">
          <summary class="chief-activity__summary">
            <span class="chief-activity__icons" aria-hidden="true">
              <For each={current().branches}>
                {(branch) => <Icon name={agentIcon(branch.specialist)} size="small" />}
              </For>
            </span>
            <span>{summary()}</span>
            <Icon name="chevron-right" size="small" data-slot="chief-activity-chevron" />
          </summary>
          <ul class="chief-activity__branches">
            <For each={current().branches}>
              {(branch) => (
                <li>
                  <Icon name={agentIcon(branch.specialist)} size="small" aria-hidden="true" />
                  <span class="chief-activity__content">
                    <span class="chief-activity__name">{branch.name}</span>
                    <Show when={branch.objective || branch.access}>
                      <span class="chief-activity__brief">
                        {branch.objective}
                        <Show when={branch.objective && branch.access}> · </Show>
                        <Show when={branch.access}>{branch.access === "read" ? "Read only" : "Can edit"}</Show>
                      </span>
                    </Show>
                    <Show when={branch.report && (branch.state === "ready" || branch.state === "reviewed")}>
                      <span class="chief-activity__report">{branch.report}</span>
                    </Show>
                  </span>
                  <span class="chief-activity__status">{label[branch.state]}</span>
                </li>
              )}
            </For>
          </ul>
        </details>
      )}
    </Show>
  )
}
