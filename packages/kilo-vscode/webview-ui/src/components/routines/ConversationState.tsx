import { Button } from "@kilocode/kilo-ui/button"
import { Component, Show } from "solid-js"

export const ConversationState: Component<{
  loading: boolean
  searching: boolean
  error?: string
  onRetry: () => void
}> = (props) => (
  <Show
    when={!props.loading}
    fallback={
      <div class="routines-thread-loading" role="status" aria-label="Loading conversation">
        <span class="routines-line-skeleton" />
        <span class="routines-line-skeleton" data-side="user" />
        <span class="routines-line-skeleton" data-size="short" />
      </div>
    }
  >
    <Show
      when={!props.error}
      fallback={
        <div class="routines-load-error" role="alert">
          <p>{props.error}</p>
          <Button type="button" size="small" variant="ghost" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      }
    >
      <p class="routines-empty">
        {props.searching
          ? "No messages match this search."
          : "Reports and follow-ups for this worker will appear here."}
      </p>
    </Show>
  </Show>
)
