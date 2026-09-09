import { For, Show, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage } from "../../types/messages"
import { RunReview } from "./RunReview"

type Reply = Extract<ExtensionMessage, { type: "routineArchive" }>

export function Archive(props: { onOpenSession?: (id: string) => void }) {
  const vscode = useVSCode()
  const id = createUniqueId()
  const [archive, setArchive] = createSignal<NonNullable<Reply["archive"]>>([])
  const [selected, setSelected] = createSignal("")
  const [runs, setRuns] = createSignal<Reply["runs"]>()
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [review, setReview] = createSignal(false)
  const [request, setRequest] = createSignal("")
  const [target, setTarget] = createSignal("")
  const [cursor, setCursor] = createSignal("")
  const [next, setNext] = createSignal<string>()
  const item = createMemo(() => archive().find((item) => item.definition.id === selected()))
  let timer: ReturnType<typeof setTimeout> | undefined
  let button: HTMLButtonElement | undefined
  const load = (agentID?: string, after?: string) => {
    clearTimeout(timer)
    if (!after) {
      setSelected(agentID ?? "")
      setRuns(undefined)
      setReview(false)
    }
    setTarget(agentID ?? "")
    setCursor(after ?? "")
    setError("")
    setLoading(true)
    const requestID = crypto.randomUUID()
    setRequest(requestID)
    timer = setTimeout(() => {
      setRequest("")
      setLoading(false)
      setError("The archive request took too long. Try again.")
    }, 15_000)
    vscode.postMessage({ type: "routineArchive", requestID, agentID, cursor: after })
  }
  const unsub = vscode.onMessage((msg) => {
    if (msg.type !== "routineArchive" || msg.requestID !== request() || (msg.agentID ?? "") !== target()) return
    clearTimeout(timer)
    setRequest("")
    setLoading(false)
    if (msg.error) {
      setError(msg.error)
      return
    }
    if (target()) {
      if (
        !msg.runs ||
        msg.runs.some((run) => run.agentID !== selected() || typeof run.at !== "number" || !Number.isFinite(run.at))
      ) {
        setError("The retained runs do not match this routine.")
        return
      }
      setRuns(msg.runs)
      return
    }
    if (!msg.archive) {
      setError("The archive response was incomplete. Try again.")
      return
    }
    const items = new Map((cursor() ? archive() : []).map((item) => [item.definition.id, item]))
    for (const entry of msg.archive) {
      if (!items.has(entry.definition.id)) items.set(entry.definition.id, entry)
    }
    setArchive([...items.values()])
    setNext(msg.next)
    setLoaded(true)
  })
  onCleanup(() => {
    clearTimeout(timer)
    unsub()
  })
  return (
    <details
      class="routines-archive"
      onToggle={(event) => {
        if (event.currentTarget.open && !loading()) {
          if (!loaded()) load(target() || undefined, cursor() || undefined)
          else if (selected() && runs() === undefined) load(selected())
        }
        if (!event.currentTarget.open) {
          if (loading() && !target()) setLoaded(false)
          clearTimeout(timer)
          setRequest("")
          setLoading(false)
          setReview(false)
        }
      }}
    >
      <summary>Removed routines</summary>
      <p class="routines-hint">
        Review retained definitions and runs. Removed routines do not launch new work. Earlier removals may not have an
        archive record.
      </p>
      <Button size="small" variant="ghost" disabled={loading()} onClick={() => load()}>
        Refresh archive
      </Button>
      <Show when={next()}>
        <Button size="small" variant="ghost" disabled={loading()} onClick={() => load(undefined, next())}>
          Load more removed routines
        </Button>
      </Show>
      <Show when={loaded() && !archive().length}>
        <p role="status">No removed routines have been archived.</p>
      </Show>
      <Show when={archive().length > 0}>
        <label for={`${id}-select`}>Removed routine</label>
        <select
          id={`${id}-select`}
          value={selected()}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (value) load(value)
            else {
              clearTimeout(timer)
              setRequest("")
              setSelected("")
              setRuns(undefined)
              setReview(false)
              setError("")
              setLoading(false)
            }
          }}
        >
          <option value="">Select a removed routine</option>
          <For each={archive()}>
            {(entry) => (
              <option value={entry.definition.id}>
                {entry.definition.name} · {new Date(entry.archivedAt).toLocaleString()}
              </option>
            )}
          </For>
        </select>
      </Show>
      <Show when={loading()}>
        <p role="status">Loading archive…</p>
      </Show>
      <Show when={error()}>
        <p class="routines-error" role="alert">
          {error()}
        </p>
        <Button size="small" onClick={() => load(target() || undefined, cursor() || undefined)}>
          Retry archive
        </Button>
      </Show>
      <Show when={item()}>
        {(entry) => (
          <>
            <h3>{entry().definition.name}</h3>
            <p>{entry().definition.objective}</p>
            <details>
              <summary>Final saved configuration</summary>
              <pre tabIndex={0} aria-label="Final saved routine configuration">
                {JSON.stringify(entry().definition, null, 2)}
              </pre>
            </details>
            <Show when={runs()?.length === 0}>
              <p role="status">No retained run history is available for this routine.</p>
            </Show>
            <Show when={(runs()?.length ?? 0) > 0}>
              <Button
                ref={button}
                size="small"
                aria-expanded={review()}
                aria-controls={review() ? `${id}-review` : undefined}
                onClick={() => setReview(!review())}
              >
                Review retained runs
              </Button>
              <Show when={review()}>
                <RunReview
                  id={`${id}-review`}
                  name={entry().definition.name}
                  agentID={selected()}
                  runs={(runs() ?? []).map((run) => ({ ...run, at: Number(run.at) }))}
                  onOpenSession={props.onOpenSession}
                  onClose={() => {
                    setReview(false)
                    queueMicrotask(() => button?.focus())
                  }}
                />
              </Show>
            </Show>
          </>
        )}
      </Show>
    </details>
  )
}
