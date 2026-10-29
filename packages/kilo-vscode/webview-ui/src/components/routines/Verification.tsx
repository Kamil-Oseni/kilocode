import { For, Show } from "solid-js"
import type { KilocodeRoutineRunsResponse } from "@kilocode/sdk/v2/client"

export function Verification(props: { outcome: KilocodeRoutineRunsResponse[number]["outcome"] }) {
  return (
    <Show when={props.outcome}>
      <Show when={props.outcome?.delivery}>
        {(delivery) => (
          <details open>
            <summary>
              Final answer: {delivery().status === "passed" ? "Exact file check passed" : "Needs review"}
            </summary>
            <p class="routines-hint">
              Checked the original delivered UTF-8 bytes separately from the earlier work audit. This does not record
              your acceptance or judge other claims in the answer.
            </p>
            <p>Approved file: {delivery().contract.path}</p>
            <p>
              Expected: {delivery().contract.bytes} bytes, SHA-256 {delivery().contract.sha256}
            </p>
            <Show
              when={delivery().reason === "final-missing"}
              fallback={
                <p>
                  Delivered: {delivery().final.bytes} bytes, SHA-256 {delivery().final.sha256}
                </p>
              }
            >
              <p>No original final text was delivered.</p>
            </Show>
            <Show when={delivery().status !== "passed"}>
              <p>The check did not pass ({delivery().reason}). The original turn is preserved and was not retried.</p>
            </Show>
          </details>
        )}
      </Show>
      <Show
        when={props.outcome?.verification}
        fallback={<p class="routines-hint">Criterion outcomes were not recorded for this result.</p>}
      >
        {(record) => (
          <details>
            <summary>Recorded criterion outcomes</summary>
            <p class="routines-hint">
              Saved when this run settled. Model assessments record the agent's claims; executable checks record their
              saved results. These do not verify the later final answer against your instructions or record your
              acceptance. Open the conversation to inspect the original evidence.
            </p>
            <ul>
              <For each={record().requirements}>
                {(item) => (
                  <li class="routines-note">
                    <strong>{item.requirement}</strong>
                    <p>
                      {item.required ? "Required" : "Optional"}:{" "}
                      {!item.passed
                        ? "Not verified"
                        : item.basis === "command"
                          ? "Saved command check passed"
                          : item.basis === "byte-equality"
                            ? "Saved byte-equality check passed"
                            : item.basis === "file-content"
                              ? "Native file-content literal check passed; factual accuracy not verified"
                              : item.basis === "model-audit"
                                ? "Agent reported satisfied"
                                : "Recorded completion claim; verification basis unavailable"}
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
