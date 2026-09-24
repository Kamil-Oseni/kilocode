import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../../context/session"
import { useServer } from "../../context/server"
import { useVSCode } from "../../context/vscode"
import { agentIcon } from "./task-tool-state"
import { chiefActivity, type ChiefPart } from "./chief-activity"
import { chiefNotesData, chiefNotesPlan, chiefUnseenNotes, type ChiefNotesData } from "./chief-notes"

export const ChiefNotesInbox: Component = () => {
  const session = useSession()
  const server = useServer()
  const vscode = useVSCode()
  const [data, setData] = createSignal<ChiefNotesData>()
  const [error, setError] = createSignal<string>()
  const [pending, setPending] = createSignal<string>()
  let queued: string | undefined
  const parts = createMemo(() => {
    const id = session.currentSessionID()
    return id ? (session.getSessionToolParts(id) as ChiefPart[]) : []
  })
  const plan = createMemo(() => {
    const id = session.currentSessionID()
    return id ? chiefNotesPlan(id, parts()) : undefined
  })
  const key = createMemo(() => {
    const current = plan()
    return current ? JSON.stringify(current) : undefined
  })
  const refresh = () => {
    const current = plan()
    if (!current || !server.isConnected() || pending()) return
    const id = crypto.randomUUID()
    setPending(id)
    setError(undefined)
    vscode.postMessage({ type: "chiefNotesRead", id, ...current })
  }
  const off = vscode.onMessage((message) => {
    if (message.type === "chiefNotesAvailable") {
      const current = plan()
      if (
        !current ||
        message.sessionID !== current.sessionID ||
        message.goalCreatedAt !== current.goalCreatedAt ||
        message.requestID !== current.requestID ||
        message.revision !== current.revision ||
        data()?.notes.some((note) => note.id === message.noteID)
      )
        return
      if (pending()) {
        queued = message.noteID
        return
      }
      refresh()
      return
    }
    if (message.type !== "chiefNotesLoaded" || message.id !== pending()) return
    setPending(undefined)
    const current = plan()
    if (!current || message.sessionID !== current.sessionID) return
    const next = chiefNotesData(message.data, current)
    if (next) {
      setData(next)
      setError(undefined)
      if (queued && !next.notes.some((note) => note.id === queued)) {
        queued = undefined
        refresh()
      } else queued = undefined
      return
    }
    setError(message.error ?? "Specialist messages could not be verified.")
  })
  onCleanup(off)
  createEffect(() => {
    const identity = key()
    const connected = server.isConnected()
    setData(undefined)
    setPending(undefined)
    setError(undefined)
    queued = undefined
    if (identity && connected) untrack(refresh)
  })
  const visible = createMemo(() => {
    const current = plan()
    const saved = data()
    if (
      !current ||
      !saved ||
      JSON.stringify(current) !==
        JSON.stringify({
          sessionID: saved.sessionID,
          goalCreatedAt: saved.goalCreatedAt,
          requestID: saved.requestID,
          revision: saved.revision,
        })
    )
      return []
    return chiefUnseenNotes(saved, parts())
  })
  const specialists = createMemo(() => {
    const current = parts().findLast((part) => part.tool === "chief_plan" && part.state.status === "completed")
    return current ? (chiefActivity(current, parts())?.branches ?? []) : []
  })

  return (
    <Show when={plan()}>
      <Show when={visible().length > 0 || !!error()}>
        <section class="chief-notes" aria-label="Specialist messages">
          <div class="chief-notes__heading">
            <span>Specialist messages</span>
            <button
              type="button"
              onClick={refresh}
              disabled={!!pending() || !server.isConnected()}
              aria-label="Refresh specialist messages"
            >
              Refresh
            </button>
          </div>
          <Show when={error()}>
            <p class="chief-notes__error" role="status">
              {error()}
            </p>
          </Show>
          <For each={visible()}>
            {(note) => {
              const specialist = () => specialists().find((branch) => branch.id === note.branchID)?.specialist
              return (
                <div class="chief-notes__message" data-note-id={note.id}>
                  <Icon name={specialist() ? agentIcon(specialist()!) : "subagent"} size="small" aria-hidden="true" />
                  <div>
                    <div class="chief-notes__name">
                      {note.branchName} <span>sent a message</span>
                    </div>
                    <p>{note.text}</p>
                  </div>
                </div>
              )
            }}
          </For>
        </section>
      </Show>
    </Show>
  )
}
