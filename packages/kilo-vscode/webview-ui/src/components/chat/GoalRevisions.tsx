import { For, Show } from "solid-js"
import type { GoalState } from "../../../../src/shared/goal"
import { GoalCriteria } from "./GoalCriteria"
import { GoalAudit } from "./GoalAudit"
import { GoalPlan } from "./GoalPlan"
import { GoalReview } from "./GoalReview"

export function GoalRevisions(props: { goal: Pick<GoalState, "createdAt" | "revisions">; sessionID?: string }) {
  return (
    <details aria-label="Earlier goal requirements">
      <summary>Earlier requirements ({props.goal.revisions?.length ?? 0})</summary>
      <p>Superseded requirements and evidence do not satisfy the current goal. Person identity was not recorded.</p>
      <Show when={props.goal.revisions?.length} fallback={<p>No earlier requirement versions were retained.</p>}>
        <For each={props.goal.revisions}>
          {(item, index) => (
            <details>
              <summary>
                Version {index() + 1}: {item.objective}
              </summary>
              <p>Replaced through {item.source === "steering" ? "conversation steering" : "goal controls"}.</p>
              <p>Replaced: {new Date(item.at).toLocaleString()}</p>
              <p>{item.objective}</p>
              <GoalReview review={item.review} historical />
              <GoalCriteria criteria={item.criteria} />
              <GoalPlan goal={item} />
              <GoalAudit
                goal={{ ...item, createdAt: props.goal.createdAt }}
                sessionID={props.sessionID}
                revisionID={item.id}
                empty
              />
            </details>
          )}
        </For>
      </Show>
    </details>
  )
}
