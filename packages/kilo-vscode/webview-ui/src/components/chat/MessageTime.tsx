import { Show, createMemo, type Component } from "solid-js"
import { useLanguage } from "../../context/language"
import { messageInstant } from "../../utils/message-time"

type Source = string | number | { createdAt?: string; time?: { created?: number } }

export const MessageTime: Component<{
  value?: Source
  side?: "user" | "assistant" | "routine"
  detail?: "time" | "date-time"
}> = (props) => {
  const language = useLanguage()
  const date = createMemo(() => messageInstant(props.value))
  const short = createMemo(() => {
    const value = date()
    if (!value) return ""
    if (props.detail === "date-time")
      return new Intl.DateTimeFormat(language.locale(), { dateStyle: "medium", timeStyle: "short" }).format(value)
    return new Intl.DateTimeFormat(language.locale(), { hour: "numeric", minute: "2-digit" }).format(value)
  })
  const full = createMemo(() => {
    const value = date()
    if (!value) return ""
    return new Intl.DateTimeFormat(language.locale(), { dateStyle: "medium", timeStyle: "long" }).format(value)
  })

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
