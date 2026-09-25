import { For, Show, createMemo, createSignal, onMount, type Accessor, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../../context/session"
import { useLocalTabs } from "../../context/local-tabs"
import { displayTitle } from "../../utils/session-title"
import { KiloLogo } from "../chat/WelcomeEmptyState"
import { CloudImportDialog } from "../chat/CloudImportDialog"
import { HistoryPicker, ordered, shortTime } from "./HistoryPicker"
import SessionList from "./SessionList"
import CloudSessionList from "./CloudSessionList"

interface HistoryViewProps {
  onSelectSession: (id: string) => void
  onBack?: () => void
  worktreeSessionIds?: Accessor<ReadonlySet<string> | undefined>
}

const HistoryView: Component<HistoryViewProps> = (props) => {
  const session = useSession()
  const tabs = useLocalTabs()
  const dialog = useDialog()
  const [open, setOpen] = createSignal(false)
  const [source, setSource] = createSignal<"local" | "cloud" | "worktree">()
  const chats = createMemo(() => ordered(session.sessions()).filter((item) => !item.parentID))
  onMount(session.loadSessions)

  const cloud = (id: string) => {
    tabs?.previewCloud(id)
    session.selectCloudSession(id)
    props.onBack?.()
  }

  const routines = () => window.postMessage({ type: "navigate", view: "routines" }, "*")

  return (
    <div class="history-view history-page">
      <div class="history-page__header">
        <button type="button" aria-label="Back to chat" onClick={() => props.onBack?.()}>
          <Icon name="arrow-left" size="small" />
        </button>
        <span>Chats</span>
        <button
          type="button"
          aria-label="Import a chat"
          onClick={() => dialog.show(() => <CloudImportDialog onImport={cloud} />)}
        >
          <Icon name="download" size="small" />
        </button>
      </div>
      <div class="history-page__body">
        <For each={chats().slice(0, 3)}>
          {(item) => (
            <button class="raya-home__row" onClick={() => props.onSelectSession(item.id)}>
              <span dir="auto">{displayTitle(item.title, "Untitled chat")}</span>
              <span>{shortTime(item.updatedAt)}</span>
            </button>
          )}
        </For>
        <button class="raya-home__all" onClick={() => setOpen(true)}>
          View all ({chats().length})
        </button>
        <div class="history-page__category">
          <button onClick={routines}>
            Routines <Icon name="chevron-right" size="small" />
          </button>
          <button onClick={() => setSource(source() === "local" ? undefined : "local")}>
            Manage chats <Icon name="chevron-right" size="small" />
          </button>
          <button onClick={() => setSource(source() === "cloud" ? undefined : "cloud")}>
            Cloud chats <Icon name="chevron-right" size="small" />
          </button>
          <Show when={props.worktreeSessionIds?.()}>
            <button onClick={() => setSource(source() === "worktree" ? undefined : "worktree")}>
              Worktree chats <Icon name="chevron-right" size="small" />
            </button>
          </Show>
        </div>
        <Show when={source() === "local"}>
          <SessionList onSelectSession={props.onSelectSession} />
        </Show>
        <Show when={source() === "cloud"}>
          <CloudSessionList onSelectSession={cloud} />
        </Show>
        <Show when={source() === "worktree"}>
          <SessionList
            onSelectSession={props.onSelectSession}
            sessionIds={() => props.worktreeSessionIds?.() ?? new Set()}
          />
        </Show>
        <Show when={!source()}>
          <div class="history-page__mark">
            <KiloLogo />
          </div>
        </Show>
      </div>
      <Show when={open()}>
        <div class="history-picker__scrim" onClick={() => setOpen(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <HistoryPicker
              onSelect={(id) => {
                setOpen(false)
                props.onSelectSession(id)
              }}
              onClose={() => setOpen(false)}
              onRoutines={() => {
                setOpen(false)
                routines()
              }}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}

export default HistoryView
