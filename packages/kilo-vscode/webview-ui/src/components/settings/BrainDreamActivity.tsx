import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { BrainDreamActivity as Run } from "../../../../src/shared/second-brain"
import { latest } from "./brain-dream-state"

const phases = {
  selection: "Reviewing selected input",
  generation: "Preparing or generating proposals",
  validation: "Checking sources and changes",
  submission: "Saving pending proposals",
  "review-pending": "Proposals ready for review",
  reconciliation: "Original run needs inspection",
  completed: "Consolidation completed",
  cancelled: "Consolidation cancelled",
  failed: "Consolidation failed",
}

export function BrainDreamActivity() {
  const vscode = useVSCode()
  const [run, setRun] = createSignal<Run>()
  const [error, setError] = createSignal(false)
  const [cancelling, setCancelling] = createSignal(false)
  const [inspecting, setInspecting] = createSignal(false)
  const [notice, setNotice] = createSignal<string>()
  let query = ""
  let cancel = ""
  let inspect = ""
  let deadline: ReturnType<typeof setTimeout> | undefined
  const open = () => {
    if (inspecting()) return
    inspect = crypto.randomUUID()
    setInspecting(true)
    setNotice()
    vscode.postMessage({ type: "secondBrain", action: "dreamInspect", id: inspect })
  }
  const refresh = () => {
    if (query) return
    query = crypto.randomUUID()
    const id = query
    deadline = setTimeout(() => {
      if (query !== id) return
      query = ""
      deadline = undefined
      setError(true)
    }, 10000)
    vscode.postMessage({ type: "secondBrain", action: "dreamActivity", id: query })
  }
  const stop = () => {
    const current = run()
    if (!current || cancelling() || error() || !["active", "settling"].includes(current.lifecycle)) return
    cancel = crypto.randomUUID()
    setCancelling(true)
    vscode.postMessage({
      type: "secondBrain",
      action: "dreamCancel",
      id: cancel,
      target: { id: current.id, owner: current.owner },
    })
  }
  const off = vscode.onMessage((message) => {
    if (message.type === "secondBrainState" && message.id === inspect && message.state.dream) {
      if (message.state.dream.status === "native-review") return
      inspect = ""
      setInspecting(false)
      setNotice(
        message.state.dream.status === "unavailable"
          ? "Saved checkpoint inspection could not finish. Keep the original run and proposal IDs for trusted inspection."
          : "Inspection command returned. Saved history does not clear unresolved cleanup or publish proposals.",
      )
      return
    }
    if (message.type !== "secondBrainState" || !message.state.dream || (message.id !== query && message.id !== cancel))
      return
    if (message.id === query) {
      clearTimeout(deadline)
      deadline = undefined
      query = ""
    }
    if (message.id === cancel) {
      cancel = ""
      setCancelling(false)
    }
    setError(message.state.dream.status === "unavailable")
    if (message.state.dream.status !== "unavailable") {
      setRun((previous) => latest(previous, message.state.dream?.activity))
    }
  })
  onMount(refresh)
  const timer = setInterval(refresh, 2000)
  onCleanup(() => {
    clearInterval(timer)
    clearTimeout(deadline)
    off()
  })
  return (
    <section class="raya-dream-activity" aria-label="Consolidation activity">
      <h5>Consolidation activity</h5>
      <Show when={run()} fallback={<p>No consolidation run reported by this extension host.</p>}>
        {(current) => (
          <>
            <p>
              {current().phase === "selection" && current().lifecycle === "joined"
                ? "Review closed before generation"
                : phases[current().phase]}
            </p>
            <p>Model: {current().model || "Not selected yet"}</p>
            <p>Project: {current().project || "Not selected yet"}</p>
            <p>Run: {current().id}</p>
            <p role="status">
              {current().lifecycle === "active"
                ? "Request in progress"
                : current().lifecycle === "settling"
                  ? "Stopping and checking cleanup"
                  : current().lifecycle === "uncertain"
                    ? "Cleanup unconfirmed; inspection required"
                    : "Request finished; proposals still require review"}
            </p>
            <Show when={["active", "settling"].includes(current().lifecycle)}>
              <Button disabled={error() || cancelling()} onClick={stop}>
                {cancelling() ? "Joining cancelled request…" : "Cancel consolidation"}
              </Button>
            </Show>
            <Show when={current().phase === "selection" && current().lifecycle === "settling"}>
              <p>Close any open native selection dialog to let cancellation finish.</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert">Activity is unavailable. Refresh before cancelling; the last displayed run may be stale.</p>
      </Show>
      <Button
        onClick={() => {
          clearTimeout(deadline)
          deadline = undefined
          query = ""
          refresh()
        }}
      >
        Refresh activity
      </Button>
      <Button disabled={inspecting()} onClick={open}>
        {inspecting() ? "Opening checkpoint…" : "Inspect saved checkpoint"}
      </Button>
      <Show when={notice()}>{(text) => <p role="status">{text()}</p>}</Show>
    </section>
  )
}
