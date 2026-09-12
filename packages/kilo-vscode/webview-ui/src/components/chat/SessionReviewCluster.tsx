import { type Component, type JSX, Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"

export const SessionReviewCluster: Component<{
  files: number
  additions: number
  deletions: number
  pending: boolean
  discarding: boolean
  reviewing: boolean
  idle: boolean
  label: string
  hint: JSX.Element
  onOpen: () => void
  onKeep: () => void
  onUndo: () => void
  onConfirm: () => void
  onCancel: () => void
}> = (props) => (
  <div class="session-review-cluster">
    <Tooltip value={props.hint} placement="top" class="session-move-changes-trigger">
      <Button
        variant="ghost"
        size="small"
        class="session-move-changes"
        classList={{
          "session-move-changes--empty": !props.files,
          "session-move-changes--has-changes": !!props.files,
        }}
        onClick={props.onOpen}
        aria-label={props.label}
      >
        <Icon name="layers" size="small" />
        <span class="session-review-label">Review changes</span>
        <Show when={props.files}>
          <span class="session-diff-add">+{props.additions}</span>
          <span class="session-diff-del">-{props.deletions}</span>
        </Show>
      </Button>
    </Tooltip>
    <Show when={props.pending}>
      <Show when={!props.discarding}>
        <Tooltip value="Keep every file edit in this chat" placement="top">
          <Button
            variant="ghost"
            size="small"
            class="session-move-changes"
            disabled={!props.idle || props.reviewing}
            onClick={props.onKeep}
          >
            {props.reviewing ? "Saving review..." : "Keep all"}
          </Button>
        </Tooltip>
      </Show>
      <Show
        when={props.discarding}
        fallback={
          <Tooltip value="Undo every file edit in this chat" placement="top">
            <Button
              variant="ghost"
              size="small"
              class="session-move-changes"
              disabled={!props.idle || props.reviewing}
              onClick={props.onUndo}
            >
              Undo all
            </Button>
          </Tooltip>
        }
      >
        <Tooltip value="This can't be undone" placement="top">
          <Button
            variant="secondary"
            size="small"
            class="session-move-changes session-move-changes--confirm"
            disabled={!props.idle || props.reviewing}
            onClick={props.onConfirm}
          >
            {props.reviewing ? "Undoing..." : "Confirm undo"}
          </Button>
        </Tooltip>
        <Button
          variant="ghost"
          size="small"
          class="session-move-changes"
          aria-label="Cancel undo"
          disabled={props.reviewing}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </Show>
    </Show>
  </div>
)
