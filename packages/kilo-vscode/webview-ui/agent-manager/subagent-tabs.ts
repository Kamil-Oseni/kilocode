import { batch, createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"
import { reorderTabs } from "../src/utils/tab-order"
import { childID } from "../src/context/session-utils"
import type { ToolPart } from "../src/types/messages"

export interface SubagentTab {
  id: string
  title: string
  parentID?: string
  agent?: string
}

export interface SubagentState {
  version: 1
  tabs: Record<string, SubagentTab[]>
  active: Record<string, string>
}

interface Options {
  current: Accessor<string | undefined>
  context?: (parentID?: string) => string
  initial?: unknown
  persist?: (state: SubagentState) => void
  sync: (id: string, parentID?: string) => void
  unsync: (id: string) => void
  show: () => void
  hide: () => void
}

const contexts = 50
const children = 100
const length = 512

function text(value: unknown, max = length) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined
}

export function restoreSubagents(value: unknown): SubagentState {
  const empty = { version: 1 as const, tabs: {}, active: {} }
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return empty
  const source = value as { tabs?: unknown; active?: unknown }
  if (!source.tabs || typeof source.tabs !== "object" || Array.isArray(source.tabs)) return empty
  const tabs: Record<string, SubagentTab[]> = {}
  for (const [scope, raw] of Object.entries(source.tabs).slice(0, contexts)) {
    if (!text(scope) || !Array.isArray(raw)) continue
    const seen = new Set<string>()
    const list = raw.slice(0, children).flatMap((item): SubagentTab[] => {
      if (!item || typeof item !== "object") return []
      const input = item as { id?: unknown; title?: unknown; parentID?: unknown; agent?: unknown }
      const id = text(input.id)
      const title = text(input.title, 200)
      const parentID = input.parentID === undefined ? undefined : text(input.parentID)
      const agent = input.agent === undefined ? undefined : text(input.agent, 100)
      if (!id || !title || seen.has(id) || (input.parentID !== undefined && !parentID)) return []
      seen.add(id)
      return [{ id, title, ...(parentID ? { parentID } : {}), ...(agent ? { agent } : {}) }]
    })
    if (list.length > 0) tabs[scope] = list
  }
  const active: Record<string, string> = {}
  if (source.active && typeof source.active === "object" && !Array.isArray(source.active)) {
    for (const [scope, raw] of Object.entries(source.active).slice(0, contexts)) {
      const id = text(raw)
      if (id && tabs[scope]?.some((tab) => tab.id === id)) active[scope] = id
    }
  }
  return { version: 1, tabs, active }
}

export function createSubagentContext(opts: {
  project: Accessor<string | undefined>
  current: Accessor<string | undefined>
  selection: Accessor<string | null>
}) {
  return (parentID?: string) => {
    const project = opts.project() ?? "single"
    return `${project}:${parentID ?? opts.current() ?? opts.selection() ?? "unassigned"}`
  }
}

export function createSubagentTabs(opts: Options) {
  const saved = restoreSubagents(opts.initial)
  const [tabs, setTabs] = createSignal<Record<string, SubagentTab[]>>(saved.tabs)
  const [active, setActive] = createSignal<Record<string, string | undefined>>(saved.active)
  const synced = new Set<string>()
  const key = (parentID?: string) => opts.context?.(parentID) ?? "default"
  const list = () => tabs()[key()] ?? []
  const selected = () => active()[key()]
  const receipt = (scope: string, id: string) => JSON.stringify([scope, id])
  const resume = () => {
    const scope = key()
    for (const tab of list()) {
      const id = receipt(scope, tab.id)
      if (synced.has(id)) continue
      synced.add(id)
      opts.sync(tab.id, tab.parentID ?? opts.current())
    }
  }
  const save = () => {
    const next = tabs()
    const current = Object.fromEntries(
      Object.entries(active()).flatMap(([scope, id]) =>
        id && next[scope]?.some((tab) => tab.id === id) ? [[scope, id]] : [],
      ),
    )
    opts.persist?.({ version: 1, tabs: next, active: current })
  }
  resume()
  createEffect(resume)

  const open = (id: string, title?: string, parentID?: string, agent?: string) => {
    if (!id) return
    const label = title?.trim().slice(0, 200) || "Sub-agent"
    const role = agent?.trim().slice(0, 100) || undefined
    const scope = key(parentID)
    const existing = (tabs()[scope] ?? []).some((tab) => tab.id === id)
    if (!existing) synced.add(receipt(scope, id))
    batch(() => {
      setTabs((prev) => {
        const current = prev[scope] ?? []
        const existing = current.find((tab) => tab.id === id)
        if (!existing)
          return { ...prev, [scope]: [...current, { id, title: label, parentID, ...(role ? { agent: role } : {}) }] }
        if (
          (title?.trim() && existing.title !== label) ||
          (!existing.parentID && parentID) ||
          (!existing.agent && role)
        ) {
          return {
            ...prev,
            [scope]: current.map((tab) =>
              tab.id === id
                ? { ...tab, title: label, parentID: tab.parentID ?? parentID, agent: tab.agent ?? role }
                : tab,
            ),
          }
        }
        return prev
      })
      setActive((prev) => ({ ...prev, [scope]: id }))
      opts.show()
    })
    if (!existing) opts.sync(id, parentID ?? opts.current())
    save()
  }

  const select = (id: string) => {
    if (!list().some((tab) => tab.id === id)) return
    setActive((prev) => ({ ...prev, [key()]: id }))
    opts.show()
    save()
  }

  const close = (id: string) => {
    const scope = key()
    const current = tabs()[scope] ?? []
    const index = current.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const next = current.filter((tab) => tab.id !== id)
    opts.unsync(id)
    synced.delete(receipt(scope, id))
    setTabs((prev) => ({ ...prev, [scope]: next }))
    if (selected() !== id) {
      save()
      return
    }
    const replacement = next[Math.min(index, next.length - 1)]
    if (replacement) {
      setActive((prev) => ({ ...prev, [scope]: replacement.id }))
      save()
      return
    }
    setActive((prev) => ({ ...prev, [scope]: undefined }))
    opts.hide()
    save()
  }

  const closeOthers = (id: string) => {
    const scope = key()
    const current = tabs()[scope] ?? []
    if (!current.some((tab) => tab.id === id)) return
    for (const tab of current) {
      if (tab.id === id) continue
      opts.unsync(tab.id)
      synced.delete(receipt(scope, tab.id))
    }
    setTabs((prev) => ({ ...prev, [scope]: current.filter((tab) => tab.id === id) }))
    setActive((prev) => ({ ...prev, [scope]: id }))
    opts.show()
    save()
  }

  const reorder = (from: string, to: string) => {
    const order = reorderTabs(
      list().map((tab) => tab.id),
      from,
      to,
    )
    if (!order) return
    const scope = key()
    setTabs((prev) => {
      const lookup = new Map((prev[scope] ?? []).map((tab) => [tab.id, tab]))
      return {
        ...prev,
        [scope]: order.flatMap((id) => {
          const tab = lookup.get(id)
          return tab ? [tab] : []
        }),
      }
    })
    save()
  }

  const reset = () => {
    const scope = key()
    for (const tab of tabs()[scope] ?? []) {
      opts.unsync(tab.id)
      synced.delete(receipt(scope, tab.id))
    }
    setTabs((prev) => ({ ...prev, [scope]: [] }))
    setActive((prev) => ({ ...prev, [scope]: undefined }))
    opts.hide()
    save()
  }

  return { tabs: list, active: selected, open, select, close, closeOthers, reorder, reset }
}

export function availableSubagents(parts: ToolPart[]): SubagentTab[] {
  const seen = new Set<string>()
  return parts.flatMap((part) => {
    const child = childID(part as Parameters<typeof childID>[0])
    if (!child || seen.has(child)) return []
    seen.add(child)
    const input = part.state.input
    const description = input.description
    const type = input.subagent_type
    const metadata = part.metadata ?? (part.state as { metadata?: Record<string, unknown> }).metadata
    const display = metadata?.displayName
    const role = metadata?.selectedAgent ?? type
    const title =
      typeof display === "string" && display.trim()
        ? display
        : typeof description === "string"
          ? description
          : typeof type === "string"
            ? type
            : "Sub-agent"
    return [{ id: child, title, ...(typeof role === "string" && role.trim() ? { agent: role } : {}) }]
  })
}

export function createSubagentToolbar(opts: {
  context: Accessor<string>
  current: Accessor<string | undefined>
  parts: (id: string) => ToolPart[]
  tabs: Accessor<SubagentTab[]>
  open: (id: string, title: string, parentID: string, agent?: string) => void
  visible: Accessor<boolean>
  show: () => void
  hide: () => void
}) {
  const available = createMemo(() => {
    const id = opts.current()
    return id ? availableSubagents(opts.parts(id)) : []
  })
  const toggle = () => {
    if (opts.visible()) {
      opts.hide()
      return
    }
    if (opts.tabs().length > 0) {
      opts.show()
      return
    }
    const id = opts.current()
    if (!id) return
    for (const tab of available()) opts.open(tab.id, tab.title, id, tab.agent)
  }
  createEffect(
    on(
      opts.context,
      () => {
        if (opts.visible() && opts.tabs().length === 0) opts.hide()
      },
      { defer: true },
    ),
  )
  return { available, toggle }
}

export function createSubagentController(opts: {
  project: Accessor<string | undefined>
  current: Accessor<string | undefined>
  selection: Accessor<string | null>
  parts: (id: string) => ToolPart[]
  visible: Accessor<boolean>
  initial?: unknown
  persist?: (state: SubagentState) => void
  show: () => void
  sync: (id: string, parentID?: string) => void
  unsync: (id: string) => void
  hide: () => void
}) {
  const context = createSubagentContext(opts)
  const tabs = createSubagentTabs({
    current: opts.current,
    context,
    initial: opts.initial,
    persist: opts.persist,
    sync: opts.sync,
    unsync: opts.unsync,
    show: opts.show,
    hide: opts.hide,
  })
  const toolbar = createSubagentToolbar({
    context: createMemo(() => context()),
    current: opts.current,
    parts: opts.parts,
    tabs: tabs.tabs,
    open: tabs.open,
    visible: opts.visible,
    show: opts.show,
    hide: opts.hide,
  })
  return { tabs, toolbar }
}

export function attachSubagentEvent(
  open: (id: string, title?: string, parentID?: string, agent?: string) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (
      event as CustomEvent<{ sessionID?: unknown; title?: unknown; parentSessionID?: unknown; agent?: unknown }>
    ).detail
    if (typeof detail?.sessionID !== "string") return
    open(
      detail.sessionID,
      typeof detail.title === "string" ? detail.title : undefined,
      typeof detail.parentSessionID === "string" ? detail.parentSessionID : undefined,
      typeof detail.agent === "string" ? detail.agent : undefined,
    )
  }
  window.addEventListener("agentManager.openSubagent", handler)
  return () => window.removeEventListener("agentManager.openSubagent", handler)
}
