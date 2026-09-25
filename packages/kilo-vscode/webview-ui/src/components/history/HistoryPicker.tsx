import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../../context/session"
import { displayTitle } from "../../utils/session-title"
import type { SessionInfo } from "../../types/messages"

export function shortTime(value: string, now = Date.now()) {
  const elapsed = Math.max(0, now - new Date(value).getTime())
  if (!Number.isFinite(elapsed)) return ""
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24
  if (elapsed < minute) return "now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  if (elapsed < day * 7) return `${Math.floor(elapsed / day)}d`
  if (elapsed < day * 30) return `${Math.floor(elapsed / (day * 7))}w`
  return `${Math.floor(elapsed / (day * 30))}mo`
}

export function ordered(items: SessionInfo[]) {
  return items.toSorted((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
}

interface Props {
  onSelect: (id: string) => void
  onClose: () => void
  onRoutines?: () => void
}

export const HistoryPicker: Component<Props> = (props) => {
  const session = useSession()
  const [query, setQuery] = createSignal("")
  const [kind, setKind] = createSignal("all")
  const items = createMemo(() =>
    ordered(session.sessions()).filter((item) => {
      if (kind() === "chats" && item.parentID) return false
      if (kind() === "specialists" && !item.parentID) return false
      return displayTitle(item.title, "Untitled chat").toLocaleLowerCase().includes(query().trim().toLocaleLowerCase())
    }),
  )

  return (
    <div class="history-picker" role="dialog" aria-label="All history">
      <label class="history-picker__search">
        <Icon name="magnifying-glass" size="small" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search recent chats"
          placeholder="Search recent chats"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose()
          }}
        />
      </label>
      <div class="history-picker__toolbar">
        <select aria-label="History type" value={kind()} onChange={(event) => setKind(event.currentTarget.value)}>
          <option value="all">All chats</option>
          <option value="chats">Chats</option>
          <option value="specialists">Specialists</option>
          <option value="routines">Routines</option>
        </select>
        <button type="button" aria-label="Close history" onClick={props.onClose}>
          <Icon name="close" size="small" />
        </button>
      </div>
      <div class="history-picker__list" role="list">
        <Show
          when={kind() !== "routines"}
          fallback={
            <button class="history-picker__row" onClick={props.onRoutines}>
              Open Routines history <Icon name="arrow-right" size="small" />
            </button>
          }
        >
          <For each={items()} fallback={<p class="history-picker__empty">No chats found</p>}>
            {(item) => (
              <button
                type="button"
                role="listitem"
                class="history-picker__row"
                classList={{ "history-picker__row--active": session.currentSessionID() === item.id }}
                onClick={() => props.onSelect(item.id)}
              >
                <span dir="auto">{displayTitle(item.title, "Untitled chat")}</span>
                <span>{shortTime(item.updatedAt)}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
