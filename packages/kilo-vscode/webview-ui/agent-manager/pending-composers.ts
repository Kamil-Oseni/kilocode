import { createEffect, createSignal, onCleanup, onMount, type Setter } from "solid-js"
import type { DurableDrafts } from "../src/utils/durable-drafts"
import type { AddSessionToWorktreeRequest, SessionInfo } from "../src/types/messages"
import type { ProjectStore } from "./project/store"
import { createNewTaskDrafts, pendingCatalog } from "./new-task-drafts"

export function createPendingComposers(opts: {
  local: string
  selection: () => string | null | undefined
  durable: Pick<DurableDrafts, "ready" | "owner" | "list" | "subscribe">
  title: () => string
  store: () => Pick<ProjectStore, "tabs">
  setActive: Setter<string | undefined>
  add: (id: string) => unknown
  clear: () => void
  blur: () => void
  post: (message: AddSessionToWorktreeRequest) => void
}) {
  const drafts = createNewTaskDrafts()
  const [status, setStatus] = createSignal(0)
  const [worktrees, setWorktrees] = createSignal<Record<string, string[]>>({})
  const stop = opts.durable.subscribe(() => setStatus((value) => value + 1))
  onCleanup(stop)
  let discovered: string | undefined
  createEffect(() => {
    status()
    const sel = opts.selection() ?? "unassigned"
    if (!opts.durable.ready()) {
      discovered = undefined
      return
    }
    const box = `agent-manager:${sel}`
    const owner = opts.durable.owner(box)
    if (!owner || discovered === owner + box) return
    discovered = owner + box
    opts.setActive(undefined)
    const store = opts.store()
    void opts.durable
      .list(box)
      .then((entries) => {
        if (opts.durable.owner(box) !== owner) return
        const ids = pendingCatalog(entries, box)
        if (sel === opts.local) store.tabs.set((current) => [...new Set([...current, ...ids])])
        else setWorktrees((current) => ({ ...current, [owner + box]: ids }))
      })
      .catch(() => {
        if (discovered === owner + box) discovered = undefined
      })
  })
  const recovered = (event: Event) => {
    if (!(event instanceof CustomEvent)) return
    const detail = event.detail
    const sel = opts.selection() ?? "unassigned"
    if (
      detail?.box !== `agent-manager:${sel}` ||
      detail.owner !== opts.durable.owner(detail.box) ||
      typeof detail.pendingID !== "string"
    )
      return
    if (sel === opts.local) {
      opts.add(detail.pendingID)
      return
    }
    setWorktrees((current) => ({
      ...current,
      [detail.owner + detail.box]: [...new Set([...(current[detail.owner + detail.box] ?? []), detail.pendingID])],
    }))
    opts.setActive(detail.pendingID)
    opts.clear()
  }
  window.addEventListener("composerDraftRecovered", recovered)
  onCleanup(() => {
    window.removeEventListener("composerDraftRecovered", recovered)
    drafts.cleanup()
  })
  onMount(() => {
    const request = (event: Event) => {
      const sel = opts.selection()
      if (!sel || sel === opts.local) return
      event.stopImmediatePropagation()
      const owner = opts.durable.owner(`agent-manager:${sel}`)
      if (!owner) return
      const draft = drafts.create(sel, owner)
      window.dispatchEvent(new CustomEvent("agentManagerCaptureDraft", { detail: { id: draft.id, owner } }))
      opts.blur()
      opts.post({ type: "agentManager.addSessionToWorktree", worktreeId: sel, requestID: draft.id })
    }
    window.addEventListener("newTaskRequest", request, true)
    onCleanup(() => window.removeEventListener("newTaskRequest", request, true))
  })
  const tabs = (box: string): SessionInfo[] => {
    status()
    const now = new Date().toISOString()
    return (worktrees()[`${opts.durable.owner(box)}${box}`] ?? []).map((id) => ({
      id,
      title: opts.title(),
      createdAt: now,
      updatedAt: now,
    }))
  }
  return {
    tabs,
    active(local: () => SessionInfo[], worktree: () => SessionInfo[]): SessionInfo[] {
      const sel = opts.selection()
      if (sel === opts.local) return local()
      if (sel) return worktree()
      return tabs("agent-manager:unassigned")
    },
    sessions(existing: (id: string) => SessionInfo[]): SessionInfo[] {
      const sel = opts.selection()
      if (!sel || sel === opts.local) return []
      return [...existing(sel), ...tabs(`agent-manager:${sel}`)]
    },
    remove(id: string) {
      const box = `agent-manager:${opts.selection() ?? "unassigned"}`
      const key = `${opts.durable.owner(box)}${box}`
      setWorktrees((current) => ({ ...current, [key]: (current[key] ?? []).filter((item) => item !== id) }))
    },
    apply(event: { worktreeId: string; sessionId: string; requestID?: string }) {
      drafts.apply(
        event.worktreeId,
        event.sessionId,
        opts.durable.owner(`agent-manager:${event.worktreeId}`),
        event.requestID,
      )
    },
  }
}
