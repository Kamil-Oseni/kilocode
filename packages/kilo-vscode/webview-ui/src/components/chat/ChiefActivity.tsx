import { Index, Show, createMemo, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../../context/session"
import { agentIcon } from "./task-tool-state"
import { chiefActivity, type ChiefEvent, type ChiefPart } from "./chief-activity"

const label = {
  planned: "Ready to start",
  working: "Working",
  ready: "Report ready",
  pending: "Ready to apply",
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
    const working = current.branches.filter((branch) => branch.state === "working").length
    if (working) return `${working} of ${current.branches.length} specialists working`
    const pending = current.branches.filter((branch) => branch.state === "pending").length
    if (pending) return `${pending} edit${pending === 1 ? "" : "s"} ready to apply`
    if (current.synthesized) return `${current.branches.length} specialist reports combined`
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
        <section class="chief-activity" aria-label="Specialist activity">
          <p class="chief-activity__heading">{summary()}</p>
          <ul class="chief-activity__branches">
            <Index each={current().branches}>
              {(branch) => (
                <li>
                  <details class="chief-activity__branch">
                    <summary class="chief-activity__summary">
                      <Icon name={agentIcon(branch().specialist)} size="small" aria-hidden="true" />
                      <span class="chief-activity__name">{branch().name}</span>
                      <span class="chief-activity__status">
                        {branch().access === "edit" && branch().state === "ready"
                          ? "Changes ready"
                          : branch().access === "edit" && branch().state === "reviewed"
                            ? "Applied"
                            : label[branch().state]}
                      </span>
                      <Icon name="chevron-right" size="small" data-slot="chief-activity-chevron" aria-hidden="true" />
                    </summary>
                    <div class="chief-activity__content">
                      <Show when={branch().objective || branch().access}>
                        <span class="chief-activity__brief">
                          {branch().objective}
                          <Show when={branch().objective && branch().access}> · </Show>
                          <Show when={branch().access}>{branch().access === "read" ? "Read only" : "Can edit"}</Show>
                        </span>
                      </Show>
                      <Show
                        when={
                          branch().report &&
                          (branch().state === "ready" || branch().state === "pending" || branch().state === "reviewed")
                        }
                      >
                        <span class="chief-activity__report">{branch().report}</span>
                      </Show>
                    </div>
                  </details>
                </li>
              )}
            </Index>
          </ul>
        </section>
      )}
    </Show>
  )
}

export const ChiefReceipt: Component<{ events: ChiefEvent[] }> = (props) => (
  <Show when={props.events.length}>
    <ul class="chief-receipt" aria-label="Specialist update">
      <Index each={props.events}>
        {(event) => (
          <li class={event().message ? "chief-receipt__note" : undefined}>
            <Icon
              name={event().specialist ? agentIcon(event().specialist) : "subagent"}
              size="small"
              aria-hidden="true"
            />
            <span>{event().name}</span>
            <span class="chief-receipt__status">{event().status}</span>
            <Show when={event().message}>{(message) => <p class="chief-receipt__message">{message()}</p>}</Show>
          </li>
        )}
      </Index>
    </ul>
  </Show>
)
