import { For, Show } from "solid-js"
import type { GoalState } from "../../../../src/shared/goal"

export function GoalPlan(props: { goal: Pick<GoalState, "objective" | "plan"> }) {
  return (
    <Show when={props.goal.plan}>
      {(plan) => (
        <section class="goal-banner__tasks" aria-label="Saved goal work plan">
          <div class="goal-banner__section-title">Saved work plan</div>
          <p>Task statuses and owners are recorded plans. Goal acceptance is checked separately.</p>
          <Show when={plan().review || plan().objective !== props.goal.objective}>
            <p role="status">
              This plan needs review after the goal requirements changed. Review it before continuing.
            </p>
          </Show>
          <For each={plan().tasks}>
            {(task) => (
              <details class="goal-banner__plan-task">
                <summary>
                  {task.id}: {task.description} — {task.status.replaceAll("_", " ")}
                </summary>
                <dl>
                  <dt>Expected output</dt>
                  <dd>{task.output}</dd>
                  <dt>Planned owner</dt>
                  <dd>{task.owner}</dd>
                  <dt>Dependencies</dt>
                  <dd>{task.dependencies.join(", ") || "None"}</dd>
                  <dt>Verification</dt>
                  <dd>{task.verification}</dd>
                </dl>
              </details>
            )}
          </For>
        </section>
      )}
    </Show>
  )
}
