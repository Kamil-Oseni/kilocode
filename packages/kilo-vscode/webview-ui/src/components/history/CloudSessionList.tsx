/**
 * CloudSessionList component
 * Displays cloud sessions from the Raya Cloud API, grouped by date.
 * Supports filtering by repository (git URL) and search by title.
 * Header/back button/import button are owned by the parent HistoryView.
 */

import { Component, For, Show, createMemo, createSignal, createEffect, on, onMount, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { formatRelativeDate } from "../../utils/date"
import type { CloudSessionInfo, ExtensionMessage } from "../../types/messages"
import { repository } from "./history-task"

const DATE_GROUP_KEYS = ["time.today", "time.yesterday", "time.thisWeek", "time.thisMonth", "time.older"] as const

function dateGroupKey(iso: string): (typeof DATE_GROUP_KEYS)[number] {
  const now = new Date()
  const then = new Date(iso)

  const DAY_MS = 24 * 60 * 60 * 1000

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - DAY_MS)
  const weekAgo = new Date(today.getTime() - 7 * DAY_MS)
  const monthAgo = new Date(today.getTime() - 30 * DAY_MS)

  if (then >= today) return DATE_GROUP_KEYS[0]
  if (then >= yesterday) return DATE_GROUP_KEYS[1]
  if (then >= weekAgo) return DATE_GROUP_KEYS[2]
  if (then >= monthAgo) return DATE_GROUP_KEYS[3]
  return DATE_GROUP_KEYS[4]
}

interface DisplaySession {
  id: string
  title: string
  updatedAt: string
  createdAt: string
  version: number
}

function toDisplay(s: CloudSessionInfo): DisplaySession {
  return {
    id: s.session_id,
    title: s.title ?? "Untitled",
    updatedAt: s.updated_at,
    createdAt: s.created_at,
    version: s.version,
  }
}

interface CloudSessionListProps {
  onSelectSession?: (id: string) => void
}

const CloudSessionList: Component<CloudSessionListProps> = (props) => {
  const vscode = useVSCode()
  const language = useLanguage()

  const [state, setState] = createStore<{ sessions: DisplaySession[] }>({ sessions: [] })
  const [sessions, setSessions] = createSignal<DisplaySession[]>([])
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal<string>()
  const visible = createMemo(() =>
    sessions().filter((item) => item.title.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase())),
  )
  const groups = createMemo(() =>
    DATE_GROUP_KEYS.map((key) => ({
      key,
      items: visible().filter((item) => dateGroupKey(item.updatedAt) === key),
    })).filter((group) => group.items.length > 0),
  )
  createEffect(() => {
    const items = visible()
    if (!items.some((item) => item.id === active())) setActive(items[0]?.id)
  })
  let panel: HTMLDivElement | undefined
  let frame: number | undefined
  function replace(items: DisplaySession[]) {
    const focused = document.activeElement
    const key =
      focused instanceof HTMLElement && panel?.contains(focused)
        ? focused.closest("[data-key]")?.getAttribute("data-key")
        : undefined
    setState("sessions", reconcile(items))
    // List observes the array reference; keep row identities but publish each response.
    setSessions([...state.sessions])
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (!key) return
    // Group regeneration replaces DOM rows. Restore only focus it displaced;
    // never take focus back after the user moves to another control.
    frame = requestAnimationFrame(() => {
      if (!panel || (document.activeElement !== document.body && document.activeElement !== focused)) return
      const row = [...panel.querySelectorAll<HTMLElement>(".history-cloud__row")].find(
        (item) => item.getAttribute("data-key") === key,
      )
      const target = row ?? panel.querySelector<HTMLElement>(".history-cloud__search input")
      target?.focus()
    })
  }
  const [loading, setLoading] = createSignal(false)
  const [nextCursor, setNextCursor] = createSignal<string | null>(null)
  const [gitUrl, setGitUrl] = createSignal<string | null>(null)
  const [repoOnly, setRepoOnly] = createSignal(true)
  const [initialized, setInitialized] = createSignal(false)
  const [notice, setNotice] = createSignal("")

  const [error, setError] = createSignal("")
  let pending: { id: string; cursor?: string } | undefined
  let retry: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  function failed(message: string) {
    retry = pending?.cursor
    pending = undefined
    clearTimeout(timer)
    setLoading(false)
    setError(message)
  }

  function load(cursor?: string) {
    clearTimeout(timer)
    const id = crypto.randomUUID()
    pending = { id, cursor }
    setLoading(true)
    setError("")
    timer = setTimeout(() => {
      if (pending?.id === id) failed("Cloud history did not respond. Retry when the connection is available.")
    }, 35_000)
    vscode.postMessage({
      type: "requestCloudSessions",
      requestID: id,
      cursor,
      limit: 50,
      gitUrl: repoOnly() ? (gitUrl() ?? undefined) : undefined,
    })
  }

  const unsub = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type === "cloudSessionsFailed") {
      if (message.requestID !== pending?.id) return
      failed(message.error)
    }
    if (message.type === "cloudSessionsLoaded") {
      const request = pending
      if (!request || message.requestID !== request.id) return
      const cursor = request.cursor
      pending = undefined
      clearTimeout(timer)
      const incoming = message.sessions.map(toDisplay)
      if (cursor) {
        const seen = new Set(sessions().map((s) => s.id))
        replace([...sessions(), ...incoming.filter((s) => !seen.has(s.id))])
      } else {
        replace(incoming)
      }
      setNextCursor(message.nextCursor)
      setLoading(false)
    }
    if (message.type === "gitRemoteUrlLoaded") {
      setGitUrl(message.gitUrl)
      setInitialized(true)
    }
  })

  onCleanup(() => {
    pending = undefined
    clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    unsub()
  })

  onMount(() => vscode.postMessage({ type: "requestGitRemoteUrl" }))

  createEffect(
    on(
      () => [initialized(), repoOnly(), gitUrl()] as const,
      ([ready]) => {
        if (!ready) return
        replace([])
        setNextCursor(null)
        load()
      },
    ),
  )

  function announce(s: DisplaySession | undefined) {
    const id = ++seq
    setNotice("")
    if (!s) return
    queueMicrotask(() => {
      if (id !== seq) return
      setNotice(s.title)
    })
  }

  function loadMore() {
    const cursor = nextCursor()
    if (!cursor || loading()) return
    load(cursor)
  }

  function searchKey(event: KeyboardEvent) {
    const items = groups().flatMap((group) => group.items)
    if (event.key === "Enter") {
      const item = items.find((item) => item.id === active())
      if (!item) return
      event.preventDefault()
      props.onSelectSession?.(item.id)
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const index = items.findIndex((item) => item.id === active())
    const next = event.key === "ArrowDown" ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0)
    setActive(items[next]?.id)
    announce(items[next])
  }

  return (
    <div ref={panel} class="cloud-session-list" aria-busy={loading()}>
      <div class="history-cloud__toolbar">
        <label class="history-cloud__search" data-slot="list-search">
          <span class="sr-only">Search cloud chats</span>
          <input
            type="search"
            placeholder="Search cloud chats"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={searchKey}
          />
        </label>
        <Button variant="ghost" size="small" disabled={loading() || !initialized()} onClick={() => load()}>
          Refresh cloud history
        </Button>
      </div>
      <Show when={gitUrl() !== null}>
        <label class="history-cloud__filter">
          <Checkbox checked={repoOnly()} onChange={setRepoOnly}>
            {language.t("session.cloud.repoOnly") ?? "Only this repository"}
          </Checkbox>
        </label>
      </Show>
      <Show when={error()}>
        <div role="alert">
          <p>{error()}</p>
          <Button variant="secondary" size="small" onClick={() => load(retry)}>
            Retry cloud history
          </Button>
        </div>
      </Show>
      <div class="history-cloud__list">
        <For
          each={groups()}
          fallback={<p class="history-picker__empty">{loading() ? "Loading cloud chats…" : "No cloud chats found"}</p>}
        >
          {(group) => (
            <section aria-label={language.t(group.key)}>
              <h3>{language.t(group.key)}</h3>
              <For each={group.items}>
                {(item) => (
                  <button
                    type="button"
                    class="history-cloud__row"
                    data-slot="list-item"
                    data-key={item.id}
                    data-active={active() === item.id}
                    onFocus={() => {
                      setActive(item.id)
                      announce(item)
                    }}
                    onClick={() => props.onSelectSession?.(item.id)}
                  >
                    <span class="history-cloud__name" dir="auto">
                      {item.title}
                    </span>
                    <time>{formatRelativeDate(item.updatedAt)}</time>
                    <small>{repoOnly() ? repository(gitUrl()) : "Cloud chat"} · Preview before importing</small>
                  </button>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
      <div data-slot="session-list-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {loading() ? "Loading cloud history..." : notice()}
      </div>
      <Show when={nextCursor() && !loading()}>
        <div class="cloud-session-load-more">
          <button class="cloud-session-load-more-btn" onClick={loadMore}>
            {language.t("common.loadMore") ?? "Load more"}
          </button>
        </div>
      </Show>
    </div>
  )
}

export default CloudSessionList
