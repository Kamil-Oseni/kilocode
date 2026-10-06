import { Show, createSignal, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"

export function BrainConsolidation(props: { configured: boolean }) {
  const vscode = useVSCode()
  const [status, setStatus] = createSignal<"native-review" | "closed" | "unavailable">()
  let id = ""
  const open = (action: "dreamStart" | "dreamInspect") => {
    if (!props.configured || status() === "native-review") return
    id = crypto.randomUUID()
    setStatus("native-review")
    vscode.postMessage({ type: "secondBrain", action, id })
  }
  const off = vscode.onMessage((message) => {
    if (message.type !== "secondBrainState" || message.id !== id || !message.state.dream) return
    setStatus(message.state.dream.status)
  })
  onCleanup(off)
  return (
    <section aria-label="Memory consolidation">
      <h5>Consolidate approved memories</h5>
      <p>
        Select approved notes, targets and a model in native review. Generated changes need separate proposal approval.
      </p>
      <Button disabled={!props.configured || status() === "native-review"} onClick={() => open("dreamStart")}>
        Consolidate approved memories
      </Button>
      <Button disabled={!props.configured || status() === "native-review"} onClick={() => open("dreamInspect")}>
        Inspect saved checkpoint
      </Button>
      <Show when={status() === "native-review"}>
        <p role="status">
          Follow the native review. Once consolidation begins, its progress notification provides Cancel.
        </p>
      </Show>
      <Show when={status() === "closed"}>
        <p role="status">
          Native review closed. Inspect the saved checkpoint and refresh proposals to see what was prepared.
        </p>
      </Show>
      <Show when={status() === "unavailable"}>
        <p role="alert">Consolidation could not be confirmed. Inspect the saved checkpoint before starting again.</p>
      </Show>
    </section>
  )
}
