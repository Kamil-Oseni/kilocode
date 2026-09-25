import { For, Show, createMemo, createSignal, onMount, type Accessor, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../../context/session"
import { useLocalTabs } from "../../context/local-tabs"
import { KiloLogo } from "../chat/WelcomeEmptyState"
import { CloudImportDialog } from "../chat/CloudImportDialog"
import { HistoryPicker, HistoryRow, ordered } from "./HistoryPicker"
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
  const [selecting, setSelecting] = createSignal(false)
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const chats = createMemo(() => ordered(session.sessions()).filter((item) => !item.parentID))
  const worktree = createMemo(() => session.sessions().filter((item) => props.worktreeSessionIds?.()?.has(item.id)))
  onMount(session.loadSessions)

  const toggle = (id: string) =>
    setSelected((value) => {
      const next = new Set(value)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const clear = () => {
    setSelected(new Set<string>())
    setSelecting(false)
  }
  const remove = () =>
    dialog.show(() => (
      <Dialog title="Delete selected chats?" fit>
        <div class="dialog-confirm-body">
          <span>{selected().size} chats will be deleted. This cannot be undone.</span>
          <div class="dialog-confirm-actions">
            <Button intent="secondary" scale="large" onClick={() => dialog.close()} autofocus>
              Cancel
            </Button>
            <Button
              intent="destructive"
              scale="large"
              onClick={() => {
                for (const id of selected()) session.deleteSession(id)
                clear()
                dialog.close()
              }}
            >
              Delete chats
            </Button>
          </div>
        </div>
      </Dialog>
    ))

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
          aria-label={selecting() ? "Done selecting chats" : "Select chats"}
          onClick={() => (selecting() ? clear() : setSelecting(true))}
        >
          {selecting() ? "Done" : "Select"}
        </button>
        <button
          type="button"
          aria-label="Import a chat"
          onClick={() => dialog.show(() => <CloudImportDialog onImport={cloud} />)}
        >
          <Icon name="download" size="small" />
        </button>
      </div>
      <div class="history-page__body">
        <Show when={selecting()}>
          <div class="history-page__selection" role="toolbar" aria-label="Selected chats">
            <span>{selected().size} selected</span>
            <button type="button" onClick={() => setSelected(new Set(chats().map((item) => item.id)))}>
              Select all
            </button>
            <button type="button" disabled={selected().size === 0} onClick={remove}>
              Delete selected
            </button>
          </div>
        </Show>
        <For each={chats().slice(0, 3)}>
          {(item) => (
            <HistoryRow
              item={item}
              variant="home"
              selecting={selecting()}
              selected={selected().has(item.id)}
              onToggle={() => toggle(item.id)}
              onSelect={() => props.onSelectSession(item.id)}
            />
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
          <HistoryPicker
            embedded
            items={chats()}
            selecting={selecting()}
            selected={selected()}
            onToggle={toggle}
            onSelect={props.onSelectSession}
          />
        </Show>
        <Show when={source() === "cloud"}>
          <CloudSessionList onSelectSession={cloud} />
        </Show>
        <Show when={source() === "worktree"}>
          <HistoryPicker
            embedded
            items={worktree()}
            selecting={selecting()}
            selected={selected()}
            onToggle={toggle}
            onSelect={props.onSelectSession}
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
              selecting={selecting()}
              selected={selected()}
              onToggle={toggle}
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
