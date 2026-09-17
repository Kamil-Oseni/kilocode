type Row = {
  id: string
  parent_id: string | null
  state: string
  budget: number | null
  cost: number | null
  session_id: string | null
}

const live = new Set(["queued", "accepted", "running", "needs_input"])

export function commitment(rows: readonly Row[]) {
  const index = new Map(rows.map((row) => [row.id, row]))
  const children = new Map<string, Row[]>()
  for (const row of rows) {
    if (!row.parent_id || !index.has(row.parent_id)) continue
    children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row])
  }
  const seen = new Set<string>()
  const reserve = (row: Row): number => {
    if (seen.has(row.id)) return 0
    seen.add(row.id)
    const child = (children.get(row.id) ?? []).reduce((total, item) => total + reserve(item), 0)
    if (live.has(row.state)) return Math.max(row.budget ?? 0, child)
    if (row.cost === null) return row.session_id ? Math.max(row.budget ?? 0, child) : child
    return row.cost + child
  }
  const roots = rows.filter((row) => !row.parent_id || !index.has(row.parent_id))
  const rooted = roots.reduce((total, row) => total + reserve(row), 0)
  return rows.reduce((total, row) => total + (seen.has(row.id) ? 0 : reserve(row)), rooted)
}
