import { For, Show, createMemo } from "solid-js"
import { media } from "../../../../src/shared/media"
import type { BrainState } from "../../../../src/shared/second-brain"

export function MediaEvidence(props: { value: NonNullable<BrainState["media"]> }) {
  const result = createMemo(() => {
    try {
      return { value: media(props.value.response, props.value) }
    } catch {
      return { error: "Media evidence could not be validated." }
    }
  })
  return (
    <section aria-label="Media evidence">
      <Show when={result().error}>{(error) => <p role="alert">{error()}</p>}</Show>
      <Show when={result().value}>
        {(value) => (
          <>
            <p>Only verified matches can support an answer. Similarity alone does not verify a match.</p>
            <For
              each={[
                { label: "Verified matches", rows: value().matches },
                { label: "Uncertain candidates", rows: value().uncertain },
                { label: "Rejected candidates", rows: value().rejected },
              ]}
            >
              {(group) => (
                <section aria-label={group.label}>
                  <h5>
                    {group.label} ({group.rows.length})
                  </h5>
                  <For each={group.rows}>
                    {(row) => (
                      <article>
                        <p>
                          {row.title || row.relative} · {row.kind}
                        </p>
                        <Show when={row.start !== null && row.end !== null}>
                          <p>
                            Recording span: {row.start}–{row.end} seconds
                          </p>
                        </Show>
                        <p>{row.path}</p>
                        <p>{row.evidence}</p>
                        <small>
                          Source SHA-256: {row.source_sha256} · Verifier: {row.verifier}
                        </small>
                      </article>
                    )}
                  </For>
                </section>
              )}
            </For>
          </>
        )}
      </Show>
    </section>
  )
}
