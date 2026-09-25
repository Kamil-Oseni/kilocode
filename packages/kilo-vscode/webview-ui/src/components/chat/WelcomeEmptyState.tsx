// raya_change - Raya primary webview branding
import { type Component, For, Show, createSignal, onMount } from "solid-js"
import { useSession } from "../../context/session"
import { HistoryPicker, HistoryRow, ordered } from "../history/HistoryPicker"

interface WelcomeEmptyStateProps {
  onSelectSession?: (id: string) => void
  onShowHistory?: () => void
}

export const KiloLogo = () => {
  return (
    <svg class="kilo-logo" viewBox="0 0 297 294" role="img" aria-label="Raya">
      <path
        fill="currentColor"
        d="M296.663 147.091C296.631 215.877 246.305 277.119 179.292 290.413C126.331 300.919 80.3876 286.715 42.305 249.184C-6.63222 200.956 -13.8143 124.176 24.4266 66.9783C49.7494 29.1023 85.4688 6.96984 130.544 1.11708C203.741 -8.38731 281.161 43.6761 294.424 122.269C295.778 130.293 296.868 138.403 296.663 147.091ZM57.0804 48.1804C55.4471 49.8452 53.746 51.4492 52.1905 53.1838C22.3795 86.4294 9.40843 125.102 17.2895 169.316C29.1447 235.824 91.7135 281.778 156.848 277.014C190.118 274.581 218.769 261.819 242.339 238.411C283.279 197.752 295.108 137.267 271.937 84.321C251.946 38.6423 217.431 11.2264 166.837 7.6809C124.838 4.7377 88.2522 18.6401 57.0804 48.1804Z"
      />
    </svg>
  )
}

export const WelcomeEmptyState: Component<WelcomeEmptyStateProps> = (props) => {
  const session = useSession()
  const [open, setOpen] = createSignal(false)
  const chats = () => ordered(session.sessions()).filter((item) => !item.parentID)
  onMount(session.loadSessions)

  return (
    <div class="message-list-empty raya-home">
      <div class="raya-home__heading">Chats</div>
      <div class="raya-home__recent">
        <For each={chats().slice(0, 3)}>
          {(item) => <HistoryRow item={item} variant="home" onSelect={() => props.onSelectSession?.(item.id)} />}
        </For>
        <Show when={chats().length > 3}>
          <button class="raya-home__all" onClick={() => setOpen(true)}>
            View all ({chats().length})
          </button>
        </Show>
      </div>
      <div class="raya-home__mark">
        <KiloLogo />
      </div>
      <Show when={open()}>
        <div class="history-picker__scrim" onClick={() => setOpen(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <HistoryPicker
              onSelect={(id) => {
                setOpen(false)
                props.onSelectSession?.(id)
              }}
              onClose={() => setOpen(false)}
              onRoutines={() => {
                setOpen(false)
                window.postMessage({ type: "navigate", view: "routines" }, "*")
              }}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}
