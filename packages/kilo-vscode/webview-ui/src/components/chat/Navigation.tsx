import { For } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"

export const destinations = [
  { id: "newTask", label: "Conversation" },
  { id: "todo", label: "Tasks" },
  { id: "routines", label: "Routines" },
  { id: "memory", label: "Memory" },
  { id: "admin", label: "Activity & health" },
  { id: "settings", label: "Settings" },
] as const

export function Navigation(props: { current: string; select: (id: (typeof destinations)[number]["id"]) => void }) {
  return (
    <nav class="raya-navigation" aria-label="Raya workspace">
      <For each={destinations}>
        {(item) => (
          <Button
            variant={props.current === item.id ? "secondary" : "ghost"}
            size="small"
            aria-current={props.current === item.id ? "page" : undefined}
            onClick={() => props.select(item.id)}
          >
            {item.label}
          </Button>
        )}
      </For>
    </nav>
  )
}
