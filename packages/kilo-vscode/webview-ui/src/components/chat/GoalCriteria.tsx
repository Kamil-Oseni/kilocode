import { For, Show } from "solid-js"
import type { GoalState } from "../../../../src/shared/goal"

export function GoalCriteria(props: { criteria: GoalState["criteria"] }) {
  return (
    <Show when={props.criteria?.length}>
      <section class="goal-banner__audit goal-banner__criteria" aria-label="Saved acceptance criteria">
        <div class="goal-banner__section-title">Acceptance criteria</div>
        <For each={props.criteria}>
          {(criterion) => (
            <div class="goal-banner__audit-req">
              <code>{criterion.id}</code>
              <span>{criterion.description}</span>
              <span>{criterion.required === false ? "Optional" : "Required"}</span>
              <Show when={criterion.review}>
                <p>Requires your review before completion.</p>
              </Show>
              <p>Verification: {criterion.verification}</p>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}
