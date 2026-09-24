export type ChiefNotesRequest = {
  type: "chiefNotesRead"
  id: string
  sessionID: string
  goalCreatedAt: number
  requestID: string
  revision: string
}

export type ChiefNotesResult = {
  type: "chiefNotesLoaded"
  id: string
  sessionID: string
  data?: unknown
  error?: string
}

export type ChiefNotesAvailable = {
  type: "chiefNotesAvailable"
  sessionID: string
  goalCreatedAt: number
  requestID: string
  revision: string
  noteID: string
}
