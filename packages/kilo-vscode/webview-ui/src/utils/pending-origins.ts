import type { DraftEntry, DraftTarget } from "../../../src/shared/composer-drafts-messages"
import { isPendingTab } from "./local-tabs"
import type { DurableDrafts } from "./durable-drafts"

type Origin = { id: string; owner: string; target: DraftTarget; label: string }
const key = (target: DraftTarget, owner: string) =>
  encodeURIComponent(JSON.stringify([owner, target.box, target.key, target.pendingID, target.sessionID]))

/** UI routing only. Original durable identities and host submission IDs are never rewritten. */
export function pendingOrigins(durable: Pick<DurableDrafts, "owner" | "view">) {
  const groups = new Map<string, Origin[]>()
  const selected = new Map<string, string>()
  const ambiguous = new Set<string>()
  const sessions = new Map<string, Origin>()
  const promoted = new Map<string, string>()
  const sources = new Map<string, Origin>()
  const valid = (row: Origin) => durable.owner(row.target.box) === row.owner
  const choices = (id: string) =>
    (groups.get(id) ?? []).filter((row) => valid(row) && promoted.get(id) !== row.id && durable.view(row.target).stored)
  const origin = (id: string) => {
    const session = sessions.get(id)
    if (session && valid(session)) return session
    const rows = choices(id)
    if (rows.length === 1 && !ambiguous.has(id)) return rows[0]
    return rows.find((row) => row.id === selected.get(id))
  }
  return {
    record(entries: DraftEntry[]) {
      for (const entry of entries) {
        if (!entry.content) continue
        const target = {
          box: entry.identity.box,
          key: entry.identity.key,
          pendingID: entry.identity.pendingID,
          sessionID: entry.identity.sessionID,
        }
        const owner = durable.owner(target.box)
        if (!owner) continue
        const mode =
          ({ auto: "General", plan: "Ask", build: "Code", code: "Code" } as Record<string, string>)[
            entry.content.agent ?? ""
          ] ?? entry.content.agent
        const name = target.box === "sidebar:new-task" ? "New task draft" : "Chat draft"
        const preview = entry.content.text.trim().replace(/\s+/g, " ").slice(0, 80) || "Draft with attachments"
        const row = { id: key(target, owner), owner, target, label: `${name}${mode ? ` · ${mode}` : ""} — ${preview}` }
        const id = target.pendingID ?? target.sessionID
        if (!id) continue
        const rows = (groups.get(id) ?? []).filter(valid)
        if (!rows.some((item) => item.id === row.id)) rows.push(row)
        groups.set(id, rows)
        if (rows.length > 1) ambiguous.add(id)
      }
    },
    choices,
    target(id?: string) {
      return id ? origin(id)?.target : undefined
    },
    choose(id: string, value: string) {
      if (!choices(id).some((row) => row.id === value)) return false
      selected.set(id, value)
      return true
    },
    source(id: string, sessionID: string) {
      const row = sources.get(sessionID) ?? origin(id)
      return row?.target.pendingID === id && valid(row) ? row.target : undefined
    },
    created(id: string, sessionID: string) {
      if (sources.has(sessionID)) return
      const row = origin(id)
      if (!row) return
      sources.set(sessionID, row)
      sessions.set(sessionID, {
        ...row,
        target: { box: row.target.box, key: `${row.target.box}:session:${sessionID}`, sessionID },
      })
      promoted.set(id, row.id)
      selected.delete(id)
    },
    pending() {
      return [...groups.keys()].filter((id) => isPendingTab(id) && choices(id).length > 0)
    },
  }
}
