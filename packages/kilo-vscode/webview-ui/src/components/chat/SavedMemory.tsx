import { Show, useContext } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { MemoryContext, useMemory } from "../../context/memory"

export function SavedMemory(props: { sessionID: string; messageID: string }) {
  const memory = useContext(MemoryContext)
  return (
    <Show when={memory?.confirmed?.(props.sessionID, props.messageID)}>
      <small data-component="memory-saved" role="status">
        Saved to memory
      </small>
    </Show>
  )
}

export function SavedConversation(props: { open: (sessionID: string) => void }) {
  const memory = useMemory()
  return (
    <Show when={memory.saved?.()}>
      {(saved) => (
        <div>
          <p>Last saved conversation</p>
          <Button onClick={() => props.open(saved().sessionID)}>View conversation</Button>
        </div>
      )}
    </Show>
  )
}
