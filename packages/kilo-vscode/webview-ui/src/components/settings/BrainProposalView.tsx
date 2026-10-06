import { For, Index, Show, createEffect, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Switch } from "@kilocode/kilo-ui/switch"
import type { BrainReview } from "../../../../src/shared/second-brain"

/** Presentation contract only; the native host owns project/source and apply authority. */
type Proposal = {
  id: string
  project: string
  digest: string
  status: string
  provenance: string
  capture_enabled: false
  sources: readonly { path: string; sha256: string; kind: string; event_time: string | null }[]
  changes: readonly { path: string; expected: string | null; content: string | null; before: string | null }[]
}

export function BrainProposalView(props: {
  proposal: Proposal
  review?: BrainReview
  pending: boolean
  uncertain?: boolean
  refresh?: () => void
  apply: () => void
  cancel: () => void
  edit: (changes: { path: string; expected: string | null; content: string | null }[]) => void
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal<Proposal["changes"]>([])
  createEffect(() => {
    const proposal = props.proposal
    setDraft(proposal.changes.map((item) => ({ ...item })))
    setEditing(false)
  })
  const update = (path: string, content: string | null) =>
    setDraft((items) => items.map((item) => (item.path === path ? { ...item, content } : item)))
  const writable = () => !props.pending && !props.uncertain && props.proposal.status === "pending"
  const invalid = () => draft().some((item) => item.content !== null && !item.content.trim())
  const clipped = (text: string | null) =>
    text === null
      ? "No note"
      : text.length > 8192
        ? `${text.slice(0, 8192)}\n[Preview shortened; complete text opens during native review.]`
        : text
  return (
    <Card>
      <h3>Proposed memory changes</h3>
      <p>Project: {props.proposal.project}</p>
      <p role="status">{props.proposal.status} · Automatic capture is off</p>
      <Show when={props.proposal.status === "applying"}>
        <p role="alert">Publication is unresolved. Read the current outcome before taking another action.</p>
      </Show>
      <Show when={props.uncertain}>
        <p role="alert">The last reply is unconfirmed. Read the current outcome before editing or applying again.</p>
      </Show>
      <Show when={props.proposal.status === "applied"}>
        <p>Changes are published. Search-index freshness is not verified by this proposal view.</p>
      </Show>
      <Show when={props.refresh}>
        <Button disabled={props.pending || (editing() && !props.uncertain)} onClick={props.refresh}>
          Read current outcome
        </Button>
      </Show>
      <p>{props.proposal.provenance}</p>
      <Show
        when={props.review?.id === props.proposal.id && props.review?.digest === props.proposal.digest && props.review}
      >
        {(review) => (
          <section aria-label="Suggestion explanation">
            <h4>Why this was suggested</h4>
            <p>{review().rationale}</p>
            <p>Original suggestion rationale; your edits require a fresh review.</p>
            <Show when={review().kind !== "memory"}>
              <p>This is a proposed {review().kind}. It does not verify a repair or establish a fact.</p>
            </Show>
            <h4>Conflicts to review</h4>
            <Show
              when={review().contradictions.length > 0}
              fallback={<p>No conflicts were recorded by this suggestion.</p>}
            >
              <ul>
                <For each={review().contradictions}>{(item) => <li>{item}</li>}</For>
              </ul>
            </Show>
            <p>These explanations are suggestions, not independently verified evidence.</p>
          </section>
        )}
      </Show>
      <details>
        <summary>Sources and revision</summary>
        <p>Proposal: {props.proposal.id}</p>
        <p>Proposal revision: {props.proposal.digest}</p>
        <For each={props.proposal.sources}>
          {(source) => (
            <p>
              {source.path} · {source.kind} · SHA-256 {source.sha256}
            </p>
          )}
        </For>
      </details>
      <Index each={draft()}>
        {(item) => (
          <section class="raya-brain-change">
            <h4>{item().path}</h4>
            <details>
              <summary>Before</summary>
              <pre>{clipped(item().before)}</pre>
            </details>
            <Show
              when={editing()}
              fallback={
                <>
                  <h5>Proposed result</h5>
                  <pre>{item().content === null ? "Delete this note" : clipped(item().content)}</pre>
                </>
              }
            >
              <Switch
                checked={item().content === null}
                disabled={!writable()}
                onChange={(checked) =>
                  update(
                    item().path,
                    checked
                      ? null
                      : (props.proposal.changes.find((change) => change.path === item().path)?.content ??
                          item().before ??
                          ""),
                  )
                }
              >
                Delete note: {item().path}
              </Switch>
              <Show when={item().content !== null}>
                <TextField
                  multiline
                  label={`Proposed text: ${item().path}`}
                  value={item().content ?? ""}
                  onChange={(value) => update(item().path, value)}
                  disabled={!writable()}
                />
              </Show>
            </Show>
          </section>
        )}
      </Index>
      <Show
        when={editing()}
        fallback={
          <div class="raya-brain-actions">
            <Button disabled={!writable()} onClick={() => setEditing(true)}>
              Edit proposed changes
            </Button>
            <Button disabled={!writable()} onClick={props.apply}>
              Open full review and apply
            </Button>
            <Button disabled={!writable()} onClick={props.cancel}>
              Discard proposal
            </Button>
          </div>
        }
      >
        <div class="raya-brain-actions">
          <Button
            disabled={!writable() || invalid()}
            onClick={() =>
              props.edit(draft().map((item) => ({ path: item.path, expected: item.expected, content: item.content })))
            }
          >
            Save proposal revision
          </Button>
          <Button
            disabled={props.pending}
            onClick={() => {
              setDraft(props.proposal.changes.map((item) => ({ ...item })))
              setEditing(false)
            }}
          >
            Cancel editing
          </Button>
        </div>
      </Show>
      <p>
        Applying opens the complete changes in VS Code for a separate confirmation. Changed sources or notes invalidate
        this proposal.
      </p>
    </Card>
  )
}
