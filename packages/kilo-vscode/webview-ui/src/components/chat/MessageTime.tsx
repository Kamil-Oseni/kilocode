import { Show, createMemo, type Component } from "solid-js"
import { useLanguage } from "../../context/language"
import { messageInstant, messageLabel, messageTitle } from "../../utils/message-time"

type Source = string | number | { createdAt?: string; time?: { created?: number } }

export const MessageTime: Component<{
  value?: Source
  side?: "user" | "assistant" | "routine"
  detail?: "time" | "date-time"
}> = (props) => {
  const language = useLanguage()
  const date = createMemo(() => messageInstant(props.value))
  const short = createMemo(() => messageLabel(date(), language.locale(), props.detail))
  const full = createMemo(() => messageTitle(date(), language.locale()))

  return (
    <Show when={date()}>
      {(value) => (
        <time
          data-component="message-time"
          data-side={props.side}
          dateTime={value().toISOString()}
          title={full()}
          aria-label={full()}
        >
          {short()}
        </time>
      )}
    </Show>
  )
}
