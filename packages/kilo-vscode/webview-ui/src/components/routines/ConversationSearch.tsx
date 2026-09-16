import { Button } from "@kilocode/kilo-ui/button"
import { Component, Show, createEffect, createSignal, onCleanup } from "solid-js"

export const ConversationSearch: Component<{
  agentID: string
  name: string
  onSearch: (query: string) => void
}> = (props) => {
  const [query, setQuery] = createSignal("")
  let agent = props.agentID
  let timer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    const id = props.agentID
    if (id === agent) return
    agent = id
    setQuery("")
    if (timer) clearTimeout(timer)
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  const change = (value: string) => {
    setQuery(value)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => props.onSearch(value.trim()), 250)
  }

  return (
    <form
      class="routines-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <label>
        <span class="sr-only">Search this conversation</span>
        <input
          type="search"
          value={query()}
          maxLength={200}
          placeholder="Search conversation"
          aria-label={`Search messages with ${props.name}`}
          onInput={(event) => change(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !query()) return
            event.preventDefault()
            event.stopPropagation()
            change("")
          }}
        />
      </label>
      <Show when={query()}>
        <Button type="button" size="small" variant="ghost" onClick={() => change("")}>
          Clear
        </Button>
      </Show>
    </form>
  )
}
