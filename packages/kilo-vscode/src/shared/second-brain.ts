export type BrainSource = Readonly<{
  path: string
  relative: string
  line: number
  end_line: number
  heading: string
  text: string
  source_sha256: string
  embedding_similarity: number
  relevance_score: number
}>

export type BrainState = Readonly<{
  configured: boolean
  status: "disconnected" | "checking" | "ready" | "searching" | "cancelled" | "unavailable"
  code?: string
  results: readonly BrainSource[]
  control?: Readonly<{
    status: "unchecked" | "reviewing" | "approved" | "syncing" | "synced" | "policy_disabled" | "uncertain"
    digest?: string
    hostJoinRequired?: boolean
  }>
}>

export type BrainRequest =
  | {
      type: "secondBrain"
      action: "state" | "setup" | "check" | "disconnect" | "controlSetup" | "review" | "sync" | "disable"
      id: string
    }
  | { type: "secondBrain"; action: "cancel"; id: string; target: string }
  | { type: "secondBrain"; action: "search"; id: string; query: string }

export type BrainResponse = { type: "secondBrainState"; id: string; state: BrainState }
