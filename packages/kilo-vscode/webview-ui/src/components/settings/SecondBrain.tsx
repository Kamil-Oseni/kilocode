import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useVSCode } from "../../context/vscode"
import { useServer } from "../../context/server"
import type { BrainState, BrainRequest, BrainCapture } from "../../../../src/shared/second-brain"
import { BrainProposals } from "./BrainProposals"
import { BrainConsolidation } from "./BrainConsolidation"
import { MediaEvidence } from "./MediaEvidence"
import { setup } from "../../../../src/shared/memory-query"

const labels: Record<string, string> = {
  setup_file_query: "This is a file path. Choose your setup file in Service settings.",
  namespace_changed: "Memory folder changed. Trusted re-admission is required.",
  retirement_pending: "Memory is waiting for the current retrieval request to retire.",
  retirement_unconfirmed: "Memory cleanup is uncertain. Trusted local inspection is required.",
  service_draining: "Memory is draining and cannot accept searches.",
  identity_mismatch: "Memory does not match the selected setup manifest.",
  setup_invalid: "Select a valid reviewed setup manifest and credential.",
  managed_generation_conflict:
    "An earlier Memory startup is incomplete. Restart Raya, then review a fresh start in Service settings.",
  unsupported: "Linked context requires a reviewed context-capable Memory release. Import its service setup first.",
  setup_changing: "Memory setup is changing. Wait for local requests to finish, then check the service.",
  transport_error: "The local Memory service could not finish the request.",
  control_setup_required: "Import a reviewed local control setup before reviewing sources.",
  control_busy: "A native Memory review or control operation is already in progress.",
  source_policy_required: "Choose notes and approve their source policy before indexing.",
  source_index_required: "Approve and index your notes before searching their contents.",
  closed_pair_recovery_required:
    "The saved Memory shutdown is unconfirmed. Restore its verified original receipt, or review a separate fresh setup.",
  control_uncertain:
    "An earlier Memory operation has not finished recovery. Inspect its original request in this session before continuing.",
}

const status: Record<BrainState["status"], string> = {
  disconnected: "Service not connected",
  checking: "Connecting to Memory…",
  ready: "Memory connected",
  searching: "Searching your indexed notes…",
  cancelled: "Search cancelled",
  unavailable: "Memory unavailable",
}

const indexing: Record<string, string> = {
  unchecked: "Choose and approve notes to index",
  reviewing: "Reviewing selected notes",
  approved: "Notes approved; indexing required",
  syncing: "Indexing selected notes…",
  synced: "Selected notes indexed; search is ready",
  policy_disabled: "Note access disabled",
  uncertain: "Indexing needs recovery",
}

const captures: Record<BrainCapture["status"], string> = {
  unavailable: "Automatic saving unavailable",
  paused: "Automatic saving paused",
  ready: "Automatic saving ready",
  saving: "Saving to Memory…",
  uncertain: "A previous save needs review",
  capacity: "Automatic saving needs space",
}

function onboarding(state: BrainState) {
  return (
    !state.configured ||
    state.status === "unavailable" ||
    state.control?.status === "uncertain" ||
    ["managed_generation_conflict", "closed_pair_recovery_required", "setup_invalid"].includes(state.code ?? "")
  )
}

export function SecondBrain() {
  const [expanded, expand] = createSignal(false)
  const vscode = useVSCode()
  const server = useServer()
  const [state, setState] = createSignal<BrainState>({ configured: false, status: "disconnected", results: [] })
  const [query, setQuery] = createSignal("")
  const [id, setId] = createSignal("")
  const [control, setControl] = createSignal<"review" | "sync">()
  const searching = () => ["checking", "searching"].includes(state().status)
  const busy = () => searching() || Boolean(control())
  const blocked = () => !state().configured || busy() || !query().trim() || setup(query())
  const request = (
    action: Exclude<
      BrainRequest["action"],
      "proposal" | "dreamStart" | "dreamInspect" | "dreamActivity" | "dreamCancel"
    >,
  ) => {
    if (control()) return
    const target = id()
    const next = crypto.randomUUID()
    setId(next)
    if (action === "review" || action === "sync") setControl(action)
    if (action === "cancel") {
      vscode.postMessage({ type: "secondBrain", action, id: next, target })
      return
    }
    if (
      action === "setup" ||
      action === "check" ||
      action === "reconcile" ||
      action === "repair" ||
      action === "archive" ||
      action === "resume"
    )
      setState({ configured: state().configured, status: "checking", results: [] })
    if (action === "search" || action === "context") {
      setState({ configured: state().configured, status: "searching", results: [] })
      vscode.postMessage(
        action === "context"
          ? { type: "secondBrain", action, id: next, query: query(), budget: 3000 }
          : { type: "secondBrain", action, id: next, query: query() },
      )
      return
    }
    vscode.postMessage({ type: "secondBrain", action, id: next })
  }
  const off = vscode.onMessage((message) => {
    if (message.type === "secondBrainState" && message.id === id()) {
      if (!message.live) setControl()
      setState(message.state)
    }
  })
  onMount(() => request("state"))
  onCleanup(() => {
    off()
    if (searching())
      vscode.postMessage({ type: "secondBrain", action: "cancel", id: crypto.randomUUID(), target: id() })
  })
  return (
    <Card class="raya-memory-service">
      <h4>Memory</h4>
      <p>
        {state().configured
          ? "Manage your notes, automatic saving and search."
          : "Let Raya remember your preferences and project details. Set it up in conversation."}
      </p>
      <p role="status">{state().configured ? status[state().status] : "Setup required"}</p>
      <Show when={onboarding(state())}>
        <Button
          variant="primary"
          onClick={() => window.dispatchEvent(new Event("raya:setup-memory"))}
          disabled={busy() || !server.isConnected()}
        >
          {state().configured ? "Continue setup with Raya" : "Set up with Raya"}
        </Button>
        <Show when={!server.isConnected()}>
          <p role="status">Connect to Raya to set up memory.</p>
        </Show>
      </Show>
      <Show when={state().root}>{(root) => <p>Notes folder: {root()}</p>}</Show>
      <Show when={state().capture}>
        {(capture) => (
          <>
            <p role="status">
              {capture().enabled === false
                ? "Automatic saving paused for new conversations"
                : captures[capture().status]}
              {capture().enabled === false && capture().status !== "paused" ? `. ${captures[capture().status]}` : ""}
              {capture().reason === "source_capacity" ? ". Review indexed notes; none were removed." : ""}
              {capture().reason === "ledger_capacity" ? ". Review capture history; existing records are retained." : ""}
            </p>
            <Show
              when={
                state().configured &&
                (capture().enabled === true ||
                  capture().status === "paused" ||
                  (capture().status === "ready" && capture().enabled !== false))
              }
            >
              <Button
                disabled={busy() || !server.isConnected()}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("raya:memory-saving", {
                      detail: { action: capture().status === "paused" ? "resume" : "pause" },
                    }),
                  )
                }
              >
                {capture().status === "paused" ? "Resume saving" : "Pause saving"}
              </Button>
            </Show>
          </>
        )}
      </Show>
      <Show when={control()}>
        {(action) => (
          <p role="status">
            {action() === "review" ? "Reviewing sources in native review…" : "Waiting for confirmed index sync…"}
          </p>
        )}
      </Show>
      <Show when={state().code}>
        <p role="alert">{labels[state().code!] ?? "Memory is unavailable. Check the local service."}</p>
      </Show>
      <Button aria-expanded={expanded()} onClick={() => expand(!expanded())}>
        Service settings
      </Button>
      <Show when={expanded()}>
        <section aria-label="Memory service settings">
          <p>Import reviewed setup files here. Keep credentials in the secure input when prompted.</p>
          <div class="raya-memory-row">
            <Button onClick={() => request("setup")} disabled={busy()}>
              Import service setup
            </Button>
            <Button onClick={() => request("check")} disabled={!state().configured || busy()}>
              Check service
            </Button>
            <Show when={state().code === "control_uncertain"}>
              <Button onClick={() => request("reconcile")} disabled={!state().configured || busy()}>
                Inspect unfinished request
              </Button>
              <Button onClick={() => request("repair")} disabled={!state().configured || busy()}>
                Recover prior failed search
              </Button>
            </Show>
            <Show when={state().configured}>
              <Button onClick={() => request("archive")} disabled={busy()}>
                Review fresh start
              </Button>
            </Show>
            <Button onClick={() => request("disconnect")} disabled={!state().configured || busy()}>
              Disconnect
            </Button>
            <Show when={state().code === "closed_pair_recovery_required"}>
              <Button onClick={() => request("resume")} disabled={busy()}>
                Restore closed Memory setup
              </Button>
            </Show>
            <Button onClick={() => request("controlSetup")} disabled={!state().configured || busy()}>
              Import control setup
            </Button>
          </div>
        </section>
      </Show>
      <div class="raya-memory-row">
        <Button onClick={() => request("review")} disabled={!state().configured || busy()}>
          Choose notes
        </Button>
        <Button
          onClick={() => request("sync")}
          disabled={
            !state().configured ||
            busy() ||
            !["unchecked", "approved", "synced"].includes(state().control?.status ?? "")
          }
        >
          Index selected notes
        </Button>
        <Button onClick={() => request("disable")} disabled={!state().configured || busy()}>
          Disable note access
        </Button>
      </div>
      <Show when={state().control}>
        <p role="status">{indexing[state().control!.status]}</p>
        <Show when={state().control!.hostJoinRequired}>
          <p>
            Source policy is disabled. Existing backend work still requires its lifecycle owner to join. Fully Paused is
            unavailable.
          </p>
        </Show>
      </Show>
      <Show
        when={state().control?.status === "synced"}
        fallback={<p>Choose notes and finish indexing to open note search.</p>}
      >
        <TextField
          label="Search your notes"
          value={query()}
          onChange={setQuery}
          placeholder="Ask about the contents of your selected notes"
        />
        <Show when={setup(query())}>
          <p role="alert">This is a file path. Choose your setup file in Service settings, then ask a question here.</p>
          <Button onClick={() => request("setup")} disabled={busy()}>
            Choose setup file
          </Button>
        </Show>
        <div class="raya-memory-row">
          <Button onClick={() => request("search")} disabled={blocked()}>
            Search notes
          </Button>
          <Button onClick={() => request("context")} disabled={blocked()}>
            Preview linked context
          </Button>
        </div>
      </Show>
      <Show when={searching()}>
        <Button onClick={() => request("cancel")}>Cancel search</Button>
      </Show>
      <Show when={state().recall === "unverified"}>
        <p role="status">
          <Show when={state().results.length} fallback="No factual passages returned. ">
            Similarity matches only.{" "}
          </Show>
          No supporting answer has been verified for this question.
        </p>
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
            <details>
              <summary>Source details</summary>
              <small>Source SHA-256: {result.source_sha256}</small>
            </details>
          </section>
        )}
      </For>
      <Show when={state().context}>
        {(context) => (
          <section aria-label="Linked memory context">
            <p>
              {context().tokens} estimated passage tokens · {context().sources.length} sources
            </p>
            <Show when={context().truncated}>
              <p role="status">Some context was omitted. Narrow your query to retrieve more relevant passages.</p>
            </Show>
            <For each={context().sources}>
              {(source) => (
                <section>
                  <h5>
                    {source.relative} · lines {source.line}–{source.end_line}
                  </h5>
                  <Show when={source.heading}>
                    <p>{source.heading}</p>
                  </Show>
                  <pre>{source.text}</pre>
                  <Show when={source.truncated}>
                    <small>Limited passage · </small>
                  </Show>
                  <details>
                    <summary>Source details</summary>
                    <small>Source SHA-256: {source.source_sha256}</small>
                  </details>
                </section>
              )}
            </For>
            <Show when={context().diagnostics.length}>
              <details>
                <summary>Skipped links ({context().diagnostics.length})</summary>
                <For each={context().diagnostics}>
                  {(row) => (
                    <p>
                      {row.relative}: {row.reason}
                    </p>
                  )}
                </For>
              </details>
            </Show>
          </section>
        )}
      </Show>
      <BrainConsolidation configured={state().configured} />
      <Show when={state().media}>{(value) => <MediaEvidence value={value()} />}</Show>
      <BrainProposals configured={state().configured} busy={busy()} index={(action) => request(action)} />
    </Card>
  )
}
