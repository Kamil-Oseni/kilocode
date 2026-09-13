import { For, Show } from "solid-js"
import type { GoalCharge } from "../../../../src/shared/goal"

const name = (item: GoalCharge) => item.service ?? item.provider ?? item.kind.replaceAll("-", " ")

export function GoalCharges(props: { items?: GoalCharge[]; historical?: boolean }) {
  const recorded = () => props.items?.filter((item) => item.coverage === "recorded") ?? []
  const unknown = () => props.items?.filter((item) => item.coverage === "unknown") ?? []
  const totals = () => {
    const sums = new Map<string, number>()
    for (const item of recorded()) sums.set(item.currency, (sums.get(item.currency) ?? 0) + item.amount)
    return [...sums]
  }

  return (
    <details aria-label={props.historical ? "Earlier non-model charges" : "Non-model charges"}>
      <summary>Other charges ({props.items?.length ?? 0})</summary>
      <Show
        when={props.items !== undefined}
        fallback={<p>No non-model charge ledger was retained for this goal version.</p>}
      >
        <Show when={props.items!.length} fallback={<p>No non-model charges were recorded.</p>}>
          <For each={totals()}>
            {([currency, amount]) => (
              <p>
                {currency} {amount.toFixed(6)} recorded.
              </p>
            )}
          </For>
          <For each={recorded()}>
            {(item) => (
              <p>
                {name(item)}: {item.currency} {item.amount.toFixed(6)}
                {item.source ? ` (billing source: ${item.source})` : ""}.
              </p>
            )}
          </For>
          <For each={unknown()}>
            {(item) => (
              <p>
                {name(item)}: {item.currency ? `${item.currency} cost unknown` : "cost unknown"}
                {item.quantity === undefined ? "." : `; ${item.quantity} ${item.unit ?? "units"}.`} {item.reason}
              </p>
            )}
          </For>
          <p>
            Recorded currencies stay separate. Unknown amounts and these charges are not added to the model-cost limit.
          </p>
        </Show>
      </Show>
    </details>
  )
}
