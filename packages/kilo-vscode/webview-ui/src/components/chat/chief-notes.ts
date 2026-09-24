import { chiefReceipt, type ChiefPart } from "./chief-activity"

export type ChiefNote = {
  version: 1
  id: string
  branchID: string
  branchName: string
  childSessionID: string
  text: string
  at: number
  state: "delivered"
}

export type ChiefNotesPlan = {
  sessionID: string
  goalCreatedAt: number
  requestID: string
  revision: string
}

export type ChiefNotesData = ChiefNotesPlan & { version: 1; notes: ChiefNote[] }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function metadata(part: ChiefPart) {
  return part.metadata ?? part.state.metadata ?? {}
}

function validNote(raw: unknown): ChiefNote | undefined {
  const note = object(raw)
  if (
    !note ||
    note.version !== 1 ||
    note.state !== "delivered" ||
    typeof note.id !== "string" ||
    !note.id ||
    typeof note.branchID !== "string" ||
    !note.branchID ||
    typeof note.branchName !== "string" ||
    !note.branchName ||
    typeof note.childSessionID !== "string" ||
    !note.childSessionID ||
    typeof note.text !== "string" ||
    !note.text.trim() ||
    note.text.length > 1_500 ||
    typeof note.at !== "number" ||
    !Number.isFinite(note.at)
  )
    return
  return note as ChiefNote
}

export function chiefNotesPlan(sessionID: string, parts: readonly ChiefPart[]): ChiefNotesPlan | undefined {
  const plan = parts.findLast((part) => part.tool === "chief_plan" && part.state.status === "completed")
  if (!plan || plan.sessionID !== sessionID) return
  const value = metadata(plan)
  if (
    typeof value.goalCreatedAt !== "number" ||
    !Number.isSafeInteger(value.goalCreatedAt) ||
    typeof value.requestID !== "string" ||
    !value.requestID ||
    typeof value.revision !== "string" ||
    !value.revision
  )
    return
  return { sessionID, goalCreatedAt: value.goalCreatedAt, requestID: value.requestID, revision: value.revision }
}

export function chiefNotesData(raw: unknown, plan: ChiefNotesPlan): ChiefNotesData | undefined {
  const value = object(raw)
  if (
    !value ||
    value.version !== 1 ||
    value.sessionID !== plan.sessionID ||
    value.goalCreatedAt !== plan.goalCreatedAt ||
    value.requestID !== plan.requestID ||
    value.revision !== plan.revision ||
    !Array.isArray(value.notes) ||
    value.notes.length > 24
  )
    return
  const seen = new Set<string>()
  const notes: ChiefNote[] = []
  for (const rawNote of value.notes) {
    const note = validNote(rawNote)
    if (!note || seen.has(note.id)) return
    seen.add(note.id)
    notes.push(note)
  }
  return { ...plan, version: 1, notes: notes.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) }
}

export function chiefUnseenNotes(data: ChiefNotesData, parts: readonly ChiefPart[]): ChiefNote[] {
  const seen = new Set<string>()
  for (const part of parts) {
    if (part.tool !== "chief_inspect" || part.state.status !== "completed") continue
    for (const event of chiefReceipt(part, parts) ?? []) {
      const saved = data.notes.find((note) => note.id === event.noteID)
      if (saved && saved.text === event.message && saved.branchName === event.name) seen.add(saved.id)
    }
  }
  return data.notes.filter((note) => !seen.has(note.id))
}
