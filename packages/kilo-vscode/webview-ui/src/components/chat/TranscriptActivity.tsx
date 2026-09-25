import { For, Show, createEffect, createSignal, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import type { TranscriptActivityRow } from "../../context/transcript-rows"
import type { TimelineHighlight } from "../../utils/timeline/highlight"
import { TranscriptRowView } from "./TranscriptRow"

interface Props {
  row: TranscriptActivityRow
  index?: number
  force?: boolean
  timing?: { start: number; end?: number; working: boolean }
  markers: Map<string, Date>
  highlight?: () => TimelineHighlight | undefined
  onForkMessage?: (sessionId: string, messageId: string) => void
}

export const TranscriptActivity: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  createEffect(() => {
    if (props.force) setOpen(true)
  })
  const duration = () => {
    const time = props.timing
    if (!time?.end || time.end < time.start) return
    const secs = Math.floor((time.end - time.start) / 1_000)
    const mins = Math.floor(secs / 60)
    return mins ? `${mins}m ${secs % 60}s` : `${secs}s`
  }
  const count = () =>
    Math.max(
      props.row.rows.length,
      props.row.rows.reduce((total, row) => total + row.parts.filter((part) => part.type === "tool").length, 0),
    )
  return (
    <div
      class="vscode-session-turn transcript-activity"
      data-row="activity"
      data-row-key={props.row.key}
      data-row-index={props.index}
      data-turn={props.row.turn}
    >
      <button
        type="button"
        class="transcript-activity__trigger"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="layers" size="small" aria-hidden="true" />
        <span>{duration() ? `Worked for ${duration()}` : "Work activity"}</span>
        <span class="transcript-activity__count">{count()} steps</span>
        <Icon name="chevron-right" size="small" class="transcript-activity__chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="transcript-activity__body">
          <For each={props.row.rows}>
            {(row) => (
              <TranscriptRowView
                row={row}
                timeline={props.markers.get(row.key)}
                highlight={props.highlight}
                onForkMessage={props.onForkMessage}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
