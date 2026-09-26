import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../../context/vscode"
import { routineFailure } from "../../utils/routine-recovery"
import type { ExtensionMessage } from "../../types/messages"
import { parse } from "./Archive"
import { Files, type Note } from "./Inbox"

export const RetainedWorkerConversation: Component<{
  agentID: string
  name: string
  onClose: () => void
}> = (props) => {
  const vscode = useVSCode()
  const [notes, setNotes] = createSignal<Note[]>([])
  const [next, setNext] = createSignal<string>()
  const [request, setRequest] = createSignal<{ id: string; cursor?: string }>()
  const [error, setError] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const read = (cursor?: string) => {
    if (request()) return
    const id = crypto.randomUUID()
    setError("")
    setRequest({ id, cursor })
    timer = setTimeout(() => {
      setRequest()
      setError("The saved conversation took too long to load. Try again.")
    }, 15_000)
    vscode.postMessage({
      type: "routineInboxPage",
      requestID: id,
      agentID: props.agentID,
      ...(cursor ? { cursor } : {}),
    })
  }

  const unsubscribe = vscode.onMessage((msg: ExtensionMessage) => {
    if (msg.type !== "routineInboxPage" || msg.agentID !== props.agentID || msg.requestID !== request()?.id) return
    clearTimeout(timer)
    const pending = request()!
    setRequest()
    if (msg.error) {
      setError(routineFailure(msg.error, msg.recovery))
      return
    }
    const page = parse(msg.messages, props.agentID)
    if (!page) {
      setError("The saved conversation could not be verified. Try again.")
      return
    }
    setNotes((prior) => {
      const ids = new Set(prior.map((note) => note.id))
      return pending.cursor ? [...page.filter((note) => !ids.has(note.id)), ...prior] : page
    })
    setNext(msg.next && msg.next !== pending.cursor ? msg.next : undefined)
    setLoaded(true)
    if (msg.next && msg.next === pending.cursor) setError("This page repeated. Reopen the conversation to continue.")
  })
  onMount(() => read())
  onCleanup(() => {
    clearTimeout(timer)
    unsubscribe()
  })

  return (
    <section class="routines-retained-conversation" aria-label={`Saved conversation with ${props.name}`}>
      <div class="routines-retained-head">
        <strong>{props.name}</strong>
        <Button variant="ghost" size="small" icon="arrow-left" onClick={props.onClose}>
          Back to team
        </Button>
      </div>
      <p class="routines-archived-note">Saved messages are read only. This worker will not restart here.</p>
      <Show when={request()}>
        <p class="routines-archived-note" role="status">
          Loading conversation…
        </p>
      </Show>
      <Show when={error()}>
        <p class="routines-organization-error" role="alert">
          {error()}
        </p>
        <Button variant="ghost" size="small" disabled={!!request()} onClick={() => read()}>
          Retry
        </Button>
      </Show>
      <Show when={loaded() && !notes().length}>
        <p class="routines-archived-empty">No saved messages for this worker.</p>
      </Show>
      <Show when={next()}>
        <Button variant="ghost" size="small" disabled={!!request()} onClick={() => read(next())}>
          Earlier messages
        </Button>
      </Show>
      <div class="routines-retained-messages">
        <For each={notes()}>
          {(note) => (
            <article class="routines-line" data-kind={note.kind}>
              <span class="routines-line-meta">
                {note.kind === "report" ? "Report" : note.kind === "user" ? "You" : "Worker"} ·{" "}
                {new Date(note.time).toLocaleString()}
              </span>
              <p class="routines-line-body">{note.body}</p>
              <Files items={note.files} session={note.sessionID} />
            </article>
          )}
        </For>
      </div>
    </section>
  )
}
