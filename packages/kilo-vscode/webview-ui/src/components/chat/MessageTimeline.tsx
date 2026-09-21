import { Show, createMemo, type Component } from "solid-js"
import { useLanguage } from "../../context/language"
import { messageInstant, messageTitle, timelineLabel } from "../../utils/message-time"

export const MessageTimeline: Component<{ value?: Date }> = (props) => {
  const language = useLanguage()
  const date = createMemo(() => messageInstant(props.value?.getTime()))
  const label = createMemo(() => timelineLabel(date(), new Date(), language.locale()))
  const full = createMemo(() => messageTitle(date(), language.locale()))

  return (
    <Show when={date()}>
      {(value) => (
        <div data-component="message-timeline">
          <time dateTime={value().toISOString()} title={full()} aria-label={full()}>
            {label()}
          </time>
        </div>
      )}
    </Show>
  )
}
