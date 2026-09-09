/**
 * CloudSessionList component
 * Displays cloud sessions from the Kilo cloud API, grouped by date.
 * Supports filtering by repository (git URL) and search by title.
 * Header/back button/import button are owned by the parent HistoryView.
 */

import { Component, Show, createSignal, createEffect, on, onMount, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { List } from "@kilocode/kilo-ui/list"
import { Button } from "@kilocode/kilo-ui/button"
import { Checkbox } from "@kilocode/kilo-ui/checkbox"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import { formatRelativeDate } from "../../utils/date"
import type { CloudSessionInfo, ExtensionMessage } from "../../types/messages"

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
}

function toDisplay(s: CloudSessionInfo): DisplaySession {
  return {
    id: s.session_id,
    title: s.title ?? "Untitled",
    updatedAt: s.updated_at,
    createdAt: s.created_at,
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
      const row = [...panel.querySelectorAll<HTMLElement>('[data-slot="list-item"]')].find(
        (item) => item.getAttribute("data-key") === key,
      )
      const target = row ?? panel.querySelector<HTMLElement>('[data-slot="list-search"] input')
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

  return (
    <div ref={panel} class="cloud-session-list" aria-busy={loading()}>
      <Button variant="ghost" size="small" disabled={loading() || !initialized()} onClick={() => load()}>
        Refresh cloud history
      </Button>
      <Show when={error()}>
        <div role="alert">
          <p>{error()}</p>
          <Button variant="secondary" size="small" onClick={() => load(retry)}>
            Retry cloud history
          </Button>
        </div>
      </Show>
      <List<DisplaySession>
        preserveActive
        items={sessions()}
        key={(s) => s.id}
        filterKeys={["title"]}
        onMove={announce}
        onSelect={(s) => {
          if (s) props.onSelectSession?.(s.id)
        }}
        search={{
          placeholder: language.t("session.search.placeholder"),
          autofocus: true,
          action:
            gitUrl() !== null ? (
              <div class="cloud-session-repo-filter">
                <Checkbox checked={repoOnly()} onChange={setRepoOnly}>
                  {language.t("session.cloud.repoOnly") ?? "Only this repository"}
                </Checkbox>
              </div>
            ) : undefined,
        }}
        emptyMessage={
          loading() ? (language.t("common.loading") ?? "Loading...") : (language.t("session.empty") ?? "No sessions")
        }
        groupBy={(s) => language.t(dateGroupKey(s.updatedAt))}
        sortGroupsBy={(a, b) => {
          const rank = Object.fromEntries(DATE_GROUP_KEYS.map((k, i) => [language.t(k), i]))
          return (rank[a.category] ?? 99) - (rank[b.category] ?? 99)
        }}
      >
        {(s) => (
          <>
            <span data-slot="list-item-title" dir="auto">
              {s.title}
            </span>
            <span data-slot="list-item-description">{formatRelativeDate(s.updatedAt)}</span>
          </>
        )}
      </List>
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
