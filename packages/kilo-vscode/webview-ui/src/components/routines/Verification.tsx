import { For, Show } from "solid-js"
import type { KilocodeRoutineRunsResponse } from "@kilocode/sdk/v2/client"

export function Verification(props: { outcome: KilocodeRoutineRunsResponse[number]["outcome"] }) {
  return (
    <Show when={props.outcome}>
      <Show
        when={props.outcome?.verification}
        fallback={<p class="routines-hint">Criterion outcomes were not recorded for this result.</p>}
      >
        {(record) => (
          <details>
            <summary>Recorded criterion outcomes</summary>
            <p class="routines-hint">
              Saved when this run settled. These are historical checks, not a new verification or your acceptance. Open
              the conversation to inspect the original evidence.
            </p>
            <ul>
              <For each={record().requirements}>
                {(item) => (
                  <li class="routines-note">
                    <strong>{item.requirement}</strong>
                    <p>
                      {item.required ? "Required" : "Optional"}:{" "}
                      {item.passed ? "Verified at completion" : "Not verified"}
                    </p>
                    <Show when={item.verification}>
                      <p>Verification method: {item.verification}</p>
                    </Show>
                    <Show when={item.evidence.length}>
                      <ul>
                        <For each={item.evidence}>{(evidence) => <li>{evidence}</li>}</For>
                      </ul>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </details>
        )}
      </Show>
    </Show>
  )
}
