import { For, Show } from "solid-js"
import type { GoalBudget, GoalBudgetOverride } from "../../../../src/shared/goal"

const summary = (budget: GoalBudget | undefined) => {
  if (!budget) return "No saved limits"
  const parts = [
    budget.activeMs === undefined ? undefined : `${Math.round(budget.activeMs / 60_000)}m active time`,
    budget.modelCost === undefined ? undefined : `$${budget.modelCost.toFixed(2)} model cost`,
    budget.recoveryAttempts === undefined ? undefined : `${budget.recoveryAttempts} recovery attempts`,
    budget.concurrentChildren === undefined ? undefined : `${budget.concurrentChildren} concurrent children`,
    ...(budget.chargeCosts ?? []).map((item) => `${item.currency} ${item.limit.toFixed(2)} other charges`),
  ].filter((item): item is string => !!item)
  return parts.length ? parts.join("; ") : "No saved limits"
}

export function GoalBudgetOverrides(props: { items?: GoalBudgetOverride[] }) {
  return (
    <details aria-label="Limit change history">
      <summary>Limit changes ({props.items?.length ?? 0})</summary>
      <Show when={props.items?.length} fallback={<p>No limit changes were recorded after this goal was created.</p>}>
        <For each={props.items?.toReversed()}>
          {(item) => (
            <div class="goal-banner__history-item">
              <span>{new Date(item.at).toLocaleString()}</span>
              <span>
                User through goal controls: {item.reason}
                <br />
                {summary(item.previous)} → {summary(item.next)}
              </span>
            </div>
          )}
        </For>
      </Show>
    </details>
  )
}
