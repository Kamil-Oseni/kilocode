export interface AgentView {
  open: boolean
  hidden: string[]
}

interface SavedView extends AgentView {
  updatedAt: number
}

interface Saved {
  version: 1
  parents: Record<string, SavedView>
}

const key = "rayaBackgroundAgents"
const parents = 50
const hidden = 100

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function view(value: unknown): SavedView | undefined {
  if (!record(value) || typeof value.open !== "boolean" || typeof value.updatedAt !== "number") return
  if (!Array.isArray(value.hidden) || value.hidden.some((item) => typeof item !== "string")) return
  return { open: value.open, hidden: [...new Set(value.hidden)].slice(-hidden), updatedAt: value.updatedAt }
}

function saved(value: unknown): Saved {
  if (!record(value) || value.version !== 1 || !record(value.parents)) return { version: 1, parents: {} }
  return {
    version: 1,
    parents: Object.fromEntries(
      Object.entries(value.parents).flatMap(([id, value]) => {
        const item = view(value)
        return id && item ? [[id, item]] : []
      }),
    ),
  }
}

export function loadAgentView(state: unknown, id: string): AgentView {
  if (!record(state)) return { open: false, hidden: [] }
  const item = saved(state[key]).parents[id]
  return item ? { open: item.open, hidden: item.hidden } : { open: false, hidden: [] }
}

export function saveAgentView(state: unknown, id: string, value: AgentView, now = Date.now()) {
  const root = record(state) ? state : {}
  const current = saved(root[key])
  const entries = Object.entries({
    ...current.parents,
    [id]: { open: value.open, hidden: [...new Set(value.hidden)].slice(-hidden), updatedAt: now },
  })
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, parents)
  return { ...root, [key]: { version: 1, parents: Object.fromEntries(entries) } }
}
