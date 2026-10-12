import { For, Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { RoutineReport } from "../../../../src/shared/routine-reports"

const labels = {
  queued: "Waiting to start",
  running: "Running",
  complete: "Run finished",
  blocked: "Needs attention",
  error: "Run failed",
} as const

/** Displays durable report cards; loading and retained history belong to the host controller. */
export const RoutineActivity: Component<{
  items: readonly RoutineReport[]
  loading?: boolean
  error?: string
  onRefresh: () => void
  onOpen: (agentID: string, workerSessionID?: string) => void
}> = (props) => (
  <Show when={props.items.length || props.error}>
    <section data-component="routine-activity" aria-label="Routine reports">
      <div data-slot="routine-activity-heading">
        <strong>Routine reports</strong>
        <Button size="small" variant="ghost" disabled={props.loading} onClick={props.onRefresh}>
          {props.loading ? "Refreshing..." : "Refresh reports"}
        </Button>
      </div>
      <Show when={props.error}>
        <p data-slot="routine-activity-error" role="status">
          {props.error} {props.items.length ? "Previously loaded reports remain visible." : ""}
        </p>
      </Show>
      <For each={props.items}>
        {(card) => (
          <article data-slot="routine-activity-card" data-report-id={card.id}>
            <div data-slot="routine-activity-heading">
              <strong>{card.name}</strong>
              <span>{labels[card.status]}</span>
            </div>
            <Show when={card.summary}>
              <p data-slot="routine-activity-body">{card.summary}</p>
            </Show>
            <Show when={card.notice}>
              {(notice) => (
                <p data-slot="routine-activity-notice">
                  Start delay recorded{" "}
                  <time dateTime={new Date(notice().at).toISOString()}>{new Date(notice().at).toLocaleString()}</time>.{" "}
                  {notice().reason === "busy" ? "Raya was busy." : "This run was deferred."}
                </p>
              )}
            </Show>
            <Show when={card.delivery === "unavailable"}>
              <p data-slot="routine-activity-error">The saved report destination is unavailable.</p>
            </Show>
            <Button size="small" variant="secondary" onClick={() => props.onOpen(card.agentID, card.workerSessionID)}>
              {card.workerSessionID ? "View worker conversation" : "View routine"}
            </Button>
          </article>
        )}
      </For>
    </section>
  </Show>
)
