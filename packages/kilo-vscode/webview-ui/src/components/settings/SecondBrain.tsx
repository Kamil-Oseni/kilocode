import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useVSCode } from "../../context/vscode"
import type { BrainState, BrainRequest } from "../../../../src/shared/second-brain"

const labels: Record<string, string> = {
  namespace_changed: "Memory folder changed. Trusted re-admission is required.",
  retirement_pending: "Memory is waiting for the current retrieval request to retire.",
  retirement_unconfirmed: "Memory cleanup is uncertain. Trusted local inspection is required.",
  service_draining: "Memory is draining and cannot accept searches.",
  identity_mismatch: "Memory does not match the selected setup manifest.",
  setup_invalid: "Select a valid reviewed setup manifest and credential.",
  setup_changing: "Memory setup is changing. Wait for local requests to finish, then check the service.",
  transport_error: "The local Memory service could not finish the request.",
  control_setup_required: "Import a reviewed local control setup before reviewing sources.",
  control_busy: "A native Memory review or control operation is already in progress.",
  control_uncertain:
    "A previous policy publication is uncertain. Its retained metadata needs trusted reconciliation; no operation is replayed.",
}

export function SecondBrain() {
  const vscode = useVSCode()
  const [state, setState] = createSignal<BrainState>({ configured: false, status: "disconnected", results: [] })
  const [query, setQuery] = createSignal("")
  const [id, setId] = createSignal("")
  const busy = () => ["checking", "searching"].includes(state().status)
  const request = (action: BrainRequest["action"]) => {
    const target = id()
    const next = crypto.randomUUID()
    setId(next)
    if (action === "cancel") {
      vscode.postMessage({ type: "secondBrain", action, id: next, target })
      return
    }
    if (action === "setup" || action === "check")
      setState({ configured: state().configured, status: "checking", results: [] })
    if (action === "search") {
      setState({ configured: state().configured, status: "searching", results: [] })
      vscode.postMessage({ type: "secondBrain", action, id: next, query: query() })
      return
    }
    vscode.postMessage({ type: "secondBrain", action, id: next })
  }
  const off = vscode.onMessage((message) => {
    if (message.type === "secondBrainState" && message.id === id()) setState(message.state)
  })
  onMount(() => request("state"))
  onCleanup(() => {
    off()
    if (busy()) vscode.postMessage({ type: "secondBrain", action: "cancel", id: crypto.randomUUID(), target: id() })
  })
  return (
    <Card>
      <h4>SecondBrain</h4>
      <p>Search your reviewed local notes. Results stay in this panel and are not added to chat.</p>
      <p role="status">{state().configured ? state().status : "Setup required"}</p>
      <Show when={state().code}>
        <p role="alert">{labels[state().code!] ?? "Memory is unavailable. Check the local service."}</p>
      </Show>
      <Button onClick={() => request("setup")} disabled={busy()}>
        Import service setup
      </Button>
      <Button onClick={() => request("check")} disabled={!state().configured || busy()}>
        Check service
      </Button>
      <Button onClick={() => request("disconnect")} disabled={!state().configured || busy()}>
        Disconnect
      </Button>
      <Button onClick={() => request("controlSetup")} disabled={!state().configured || busy()}>
        Import control setup
      </Button>
      <Button onClick={() => request("review")} disabled={!state().configured || busy()}>
        Review sources
      </Button>
      <Button onClick={() => request("sync")} disabled={!state().configured || busy()}>
        Confirm sync
      </Button>
      <Button onClick={() => request("disable")} disabled={!state().configured || busy()}>
        Disable source policy
      </Button>
      <Show when={state().control}>
        <p role="status">Source policy: {state().control!.status}</p>
        <Show when={state().control!.hostJoinRequired}>
          <p>
            Source policy is disabled. Existing backend work still requires its lifecycle owner to join. Fully Paused is
            unavailable.
          </p>
        </Show>
      </Show>
      <TextField
        label="Search local notes"
        value={query()}
        onChange={setQuery}
        placeholder="What would you like to find?"
      />
      <Button onClick={() => request("search")} disabled={!state().configured || busy() || !query().trim()}>
        Search notes
      </Button>
      <Show when={busy()}>
        <Button onClick={() => request("cancel")}>Cancel search</Button>
      </Show>
      <For each={state().results}>
        {(result) => (
          <section>
            <h5>
              {result.relative} · lines {result.line}–{result.end_line}
            </h5>
            <Show when={result.heading}>
              <p>{result.heading}</p>
            </Show>
            <pre>{result.text}</pre>
            <small>Source SHA-256: {result.source_sha256}</small>
          </section>
        )}
      </For>
      <p>
        Review and sync require separate native confirmations. Disconnect joins local transport only. Capture is
        disabled.
      </p>
    </Card>
  )
}
