import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { reason } from "./run"
import { Verification } from "./Verification"

type Reply = Extract<ExtensionMessage, { type: "routineSnapshot" }>

export function RunReview(props: {
  id: string
  name: string
  onClose: () => void
  onOpenSession?: (id: string) => void
  agentID: string
  selected?: string
  runs: {
    id: string
    at: number
    status: string
    sessionID?: string
    blockedReason?: string
    trigger?: import("@kilocode/sdk/v2/client").KilocodeRoutineRunsResponse[number]["trigger"]
    outcome?: import("@kilocode/sdk/v2/client").KilocodeRoutineRunsResponse[number]["outcome"]
  }[]
}) {
  const vscode = useVSCode()
  const [selected, setSelected] = createSignal(props.selected ?? props.runs.at(-1)?.id ?? "")
  const [request, setRequest] = createSignal("")
  const [reply, setReply] = createSignal<Reply>()
  const run = createMemo(() => props.runs.find((run) => run.id === selected()))
  let timer: ReturnType<typeof setTimeout> | undefined
  let panel: HTMLElement | undefined
  onMount(() => panel?.focus())
  const load = () => {
    clearTimeout(timer)
    setReply(undefined)
    const runID = selected()
    if (!runID) return
    const requestID = crypto.randomUUID()
    setRequest(requestID)
    timer = setTimeout(() => {
      setReply({
        type: "routineSnapshot",
        requestID,
        agentID: props.agentID,
        runID,
        error: "The request took too long. Try again.",
      })
    }, 15_000)
    vscode.postMessage({ type: "routineSnapshot", requestID, agentID: props.agentID, runID })
  }
  const unsub = vscode.onMessage((msg) => {
    if (
      msg.type !== "routineSnapshot" ||
      msg.requestID !== request() ||
      msg.agentID !== props.agentID ||
      msg.runID !== selected()
    )
      return
    clearTimeout(timer)
    if (msg.snapshot && (msg.snapshot.runID !== selected() || msg.snapshot.agentID !== props.agentID)) {
      setReply({ ...msg, snapshot: undefined, error: "The saved instructions do not match this run." })
      return
    }
    setReply(msg)
  })
  createEffect(load)
  onCleanup(() => {
    clearTimeout(timer)
    unsub()
  })
  return (
    <section
      ref={panel}
      id={props.id}
      class="routines-instructions"
      aria-label={`Run review for ${props.name}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.target.tagName === "SELECT") return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
    >
      <div class="routines-instructions-heading">
        <h3>Run review: {props.name}</h3>
        <Button size="small" variant="ghost" onClick={props.onClose}>
          Close review
        </Button>
      </div>
      <label>
        Saved run
        <select value={selected()} onChange={(event) => setSelected(event.currentTarget.value)}>
          <Show when={props.selected && !props.runs.some((run) => run.id === props.selected)}>
            <option value={props.selected}>Run without saved history · {props.selected}</option>
          </Show>
          <For each={props.runs}>
            {(run) => (
              <option value={run.id}>
                {new Date(run.at).toLocaleString()} · {run.status} · {run.id}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show
        when={run()}
        fallback={
          <p class="routines-hint">
            Run history has not been recorded. Saved startup instructions may still be available below.
          </p>
        }
      >
        {(current) => (
          <div class="routines-result">
            <p class="routines-note">{reason(current())}</p>
            <h3>Recorded result</h3>
            <Show
              when={current().outcome?.summary}
              fallback={<p class="routines-hint">No result summary has been recorded for this run.</p>}
            >
              <p class="routines-note">{current().outcome?.summary}</p>
            </Show>
            <Show when={current().blockedReason}>
              <p class="routines-note">{current().blockedReason}</p>
            </Show>
            <Verification outcome={current().outcome} />
            <Show when={!current().outcome?.verification && current().outcome?.evidence?.length}>
              <details>
                <summary>Recorded evidence</summary>
                <ul>
                  <For each={current().outcome?.evidence}>{(item) => <li class="routines-note">{item}</li>}</For>
                </ul>
              </details>
            </Show>
            <Show when={current().sessionID && props.onOpenSession}>
              <Button
                size="small"
                variant="secondary"
                onClick={() => {
                  const id = current().sessionID
                  if (id) props.onOpenSession?.(id)
                }}
              >
                Open conversation
              </Button>
            </Show>
          </div>
        )}
      </Show>
      <p class="routines-hint">Instructions saved when this run started. Later routine edits are not included.</p>
      <Show when={!reply()}>
        <p role="status">Loading saved instructions…</p>
      </Show>
      <Show when={reply()?.missing}>
        <p role="status">
          No saved instructions are available. Startup may have stopped before saving them, this run may predate
          snapshots, or its saved instructions are no longer available.
        </p>
      </Show>
      <Show when={reply()?.error}>
        <p class="routines-error" role="alert">
          {[reply()?.error, reply()?.recovery?.next].filter(Boolean).join(" ")}
        </p>
        <Button size="small" variant="secondary" onClick={load}>
          Try again
        </Button>
      </Show>
      <Show when={reply()?.snapshot}>
        {(snapshot) => (
          <>
            <h3>Original instructions</h3>
            <pre tabIndex={0} aria-label="Original instructions">
              {snapshot().objective}
            </pre>
            <details>
              <summary>Saved routine definition</summary>
              <pre tabIndex={0} aria-label="Saved routine definition">
                {JSON.stringify(snapshot().definition, null, 2)}
              </pre>
            </details>
          </>
        )}
      </Show>
    </section>
  )
}
