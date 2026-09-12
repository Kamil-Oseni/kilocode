import { type Component, type JSX, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"

export const EditReviewChrome: Component<{
  status: string
  note?: string
  pending?: boolean
  busy?: boolean
  nav?: { index: number; total: number }
  onUndo?: () => void
  onKeep?: () => void
  onPrev?: () => void
  onNext?: () => void
  children?: JSX.Element
  setRef?: (el: HTMLDivElement) => void
}> = (props) => (
  <div
    ref={(el) => props.setRef?.(el)}
    data-component="edit-review-block"
    data-review-status={props.status}
    data-review-pending={props.pending ? "" : undefined}
  >
    {props.children}
    <Show when={props.pending}>
      <div data-slot="edit-review-actions">
        <Show when={props.note}>
          <span data-slot="edit-review-note">{props.note}</span>
        </Show>
        <Button
          variant="ghost"
          size="small"
          data-slot="edit-review-undo"
          disabled={props.busy}
          onClick={props.onUndo}
          title="Undo the latest unaccepted edit in this file"
        >
          Undo file
        </Button>
        <Button
          variant="ghost"
          size="small"
          data-slot="edit-review-keep"
          disabled={props.busy}
          onClick={props.onKeep}
          title="Keep all current edits in this file"
        >
          Keep file
        </Button>
        <Show when={(props.nav?.total ?? 0) > 1 && (props.nav?.index ?? -1) >= 0}>
          <span data-slot="edit-review-nav">
            <button type="button" aria-label="Previous edit" onClick={props.onPrev}>
              ‹
            </button>
            <span data-slot="edit-review-count">
              {(props.nav?.index ?? 0) + 1} of {props.nav?.total ?? 0}
            </span>
            <button type="button" aria-label="Next edit" onClick={props.onNext}>
              ›
            </button>
          </span>
        </Show>
      </div>
    </Show>
  </div>
)
