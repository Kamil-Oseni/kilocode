import { Show } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { useMemory } from "../../context/memory"
import { MemoryActions } from "./ContextTab"
import { SecondBrain } from "./SecondBrain"

export function MemoryView(props: { settings: () => void }) {
  const memory = useMemory()
  return (
    <div class="raya-memory-view">
      <h2>Memory</h2>
      <p>Find source-backed notes and review changes before saving them.</p>
      <SecondBrain />
      <Card>
        <h3>Current project memory</h3>
        <p>{memory.status()?.root ?? "Connect to the workspace to load project memory."}</p>
        <Button onClick={() => memory.inspect()} disabled={!memory.enabled() || memory.pending() || memory.loading()}>
          Inspect remembered facts
        </Button>
        <MemoryActions memory={memory} />
        <Show when={memory.error()}>{(error) => <p role="alert">{error()}</p>}</Show>
      </Card>
      <Button onClick={props.settings}>Context and memory settings</Button>
    </div>
  )
}
