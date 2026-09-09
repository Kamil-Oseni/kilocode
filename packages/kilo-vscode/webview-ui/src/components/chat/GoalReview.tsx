import { For, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import type { GoalState } from "../../../../src/shared/goal"

export function GoalReview(props: {
  review: GoalState["review"]
  historical?: boolean
  disabled?: boolean
  error?: string
  onAccept?: () => void
}) {
  return (
    <Show when={props.review}>
      {(review) => (
        <section aria-label="Goal review">
          <strong>
            {review().status === "accepted"
              ? "Goal accepted through review"
              : props.historical
                ? "Review was pending"
                : "Ready for your review"}
          </strong>
          <p>
            {review().status === "accepted"
              ? "Acceptance was recorded through goal controls. This does not verify later artifact changes or identify a person."
              : "Automated evidence is available. Review the results for these criteria before accepting the goal:"}
          </p>
          <ul>
            <For each={review().criteria}>{(id) => <li>{id}</li>}</For>
          </ul>
          <Show when={!props.historical && review().status === "pending" && props.onAccept}>
            <Button size="small" variant="primary" disabled={props.disabled} onClick={props.onAccept}>
              Accept reviewed goal
            </Button>
            <p>Acceptance rechecks the saved evidence. Use Steer to request changes instead.</p>
            <Show when={props.error}>
              <p role="alert">{props.error}</p>
            </Show>
          </Show>
        </section>
      )}
    </Show>
  )
}
