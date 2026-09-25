import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { DropdownMenu } from "@kilocode/kilo-ui/dropdown-menu"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useLanguage } from "../../context/language"
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

export const HistoryRow: Component<{
  item: SessionInfo
  onSelect: () => void
  variant?: "home" | "picker"
  selecting?: boolean
  selected?: boolean
  onToggle?: () => void
}> = (props) => {
  const session = useSession()
  const dialog = useDialog()
  const language = useLanguage()
  const name = () => displayTitle(props.item.title, "Untitled chat")
  const [renaming, setRenaming] = createSignal(false)
  const [title, setTitle] = createSignal("")
  const remove = () =>
    dialog.show(() => (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("session.delete.confirm", { name: name() })}</span>
          <div class="dialog-confirm-actions">
            <Button intent="secondary" scale="large" onClick={() => dialog.close()} autofocus>
              {language.t("common.cancel")}
            </Button>
            <Button
              intent="destructive"
              scale="large"
              onClick={() => {
                session.deleteSession(props.item.id)
                dialog.close()
              }}
            >
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  return (
    <div class="history-entry" role={props.variant === "picker" ? "listitem" : undefined}>
      <Show when={props.selecting}>
        <input type="checkbox" aria-label={`Select ${name()}`} checked={props.selected} onChange={props.onToggle} />
      </Show>
      <Show
        when={renaming()}
        fallback={
          <button
            type="button"
            class={props.variant === "home" ? "raya-home__row" : "history-picker__row"}
            classList={{ "history-picker__row--active": session.currentSessionID() === props.item.id }}
            onClick={() => (props.selecting ? props.onToggle?.() : props.onSelect())}
          >
            <span dir="auto">{name()}</span>
            <span>{shortTime(props.item.updatedAt)}</span>
          </button>
        }
      >
        <form
          class="history-entry__rename"
          onSubmit={(event) => {
            event.preventDefault()
            if (title().trim()) session.renameSession(props.item.id, title().trim())
            setRenaming(false)
          }}
        >
          <input
            aria-label={`Rename ${name()}`}
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false)
            }}
            autofocus
          />
          <button type="submit">Save</button>
        </form>
      </Show>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger class="history-entry__more" aria-label={`More options for ${name()}`}>
          <span aria-hidden="true">•••</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="history-entry__menu">
            <DropdownMenu.Item
              onSelect={() => {
                setTitle(props.item.title ?? "")
                setRenaming(true)
              }}
            >
              <Icon name="edit" size="small" />
              <DropdownMenu.ItemLabel>Rename chat</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => session.exportSessionTranscript(props.item.id)}>
              <Icon name="download" size="small" />
              <DropdownMenu.ItemLabel>Export chat</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={remove}>
              <Icon name="trash" size="small" />
              <DropdownMenu.ItemLabel>Delete chat</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

interface Props {
  onSelect: (id: string) => void
  onClose?: () => void
  onRoutines?: () => void
  embedded?: boolean
  items?: SessionInfo[]
  selecting?: boolean
  selected?: ReadonlySet<string>
  onToggle?: (id: string) => void
}

export const HistoryPicker: Component<Props> = (props) => {
  const session = useSession()
  const [query, setQuery] = createSignal("")
  const [kind, setKind] = createSignal("all")
  const items = createMemo(() =>
    ordered(props.items ?? session.sessions()).filter((item) => {
      if (kind() === "chats" && item.parentID) return false
      if (kind() === "specialists" && !item.parentID) return false
      return displayTitle(item.title, "Untitled chat").toLocaleLowerCase().includes(query().trim().toLocaleLowerCase())
    }),
  )

  return (
    <div
      class="history-picker"
      data-embedded={props.embedded}
      role={props.embedded ? undefined : "dialog"}
      aria-label="All history"
    >
      <label class="history-picker__search">
        <Icon name="magnifying-glass" size="small" aria-hidden="true" />
        <input
          type="search"
          aria-label="Search recent chats"
          placeholder="Search recent chats"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose?.()
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
        <Show when={!props.embedded}>
          <button type="button" aria-label="Close history" onClick={props.onClose}>
            <Icon name="close" size="small" />
          </button>
        </Show>
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
              <HistoryRow
                item={item}
                variant="picker"
                selecting={props.selecting}
                selected={props.selected?.has(item.id)}
                onToggle={() => props.onToggle?.(item.id)}
                onSelect={() => props.onSelect(item.id)}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
