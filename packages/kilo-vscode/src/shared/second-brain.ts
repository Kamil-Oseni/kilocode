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

export type BrainContext = Readonly<{
  sources: readonly Readonly<{
    path: string
    relative: string
    line: number
    end_line: number
    heading: string
    text: string
    source_sha256: string
    depth: number
    tokens: number
    truncated: boolean
  }>[]
  diagnostics: readonly Readonly<{ relative: string; reason: string }>[]
  tokens: number
  truncated: boolean
  capture_enabled: false
}>

export type BrainState = Readonly<{
  configured: boolean
  status: "disconnected" | "checking" | "ready" | "searching" | "cancelled" | "unavailable"
  code?: string
  proposals?: BrainProposalResult
  review?: BrainReview
  context?: BrainContext
  root?: string
  results: readonly BrainSource[]
  control?: Readonly<{
    status: "unchecked" | "reviewing" | "approved" | "syncing" | "synced" | "policy_disabled" | "uncertain"
    digest?: string
    hostJoinRequired?: boolean
  }>
}>

export type BrainRequest =
  | { type: "secondBrain"; action: "proposal"; id: string; command: BrainProposalCommand }
  | {
      type: "secondBrain"
      action: "state" | "setup" | "check" | "disconnect" | "controlSetup" | "review" | "sync" | "disable"
      id: string
    }
  | { type: "secondBrain"; action: "cancel"; id: string; target: string }
  | { type: "secondBrain"; action: "search"; id: string; query: string }
  | { type: "secondBrain"; action: "context"; id: string; query: string; budget: number }

export type BrainResponse = { type: "secondBrainState"; id: string; state: BrainState }

/** Read-only explanation from the matching saved candidate, outside the signed publication record. */
export type BrainReview = Readonly<{
  id: string
  digest: string
  fingerprint: string
  kind: "memory" | "hypothesis" | "lesson"
  rationale: string
  contradictions: readonly string[]
}>

export type BrainProposal = Readonly<{
  format: "raya.memory.proposal.v1"
  id: string
  project: string
  digest: string
  status: "pending" | "cancelled" | "applying" | "applied"
  capture_enabled: false
  sources: readonly {
    path: string
    sha256: string
    kind: "user_statement" | "tool_observation" | "document" | "assistant_interpretation"
    event_time: string | null
  }[]
  changes: readonly { path: string; expected: string | null; content: string | null; before: string | null }[]
  provenance: string
}>
export type BrainProposalResult =
  | BrainProposal
  | Readonly<{ proposals: readonly BrainProposal[]; capture_enabled: false }>
export type BrainProposalCommand =
  | { action: "list"; project: string }
  | { action: "read"; project: string; id: string }
  | {
      action: "propose"
      project: string
      id: string
      request: { changes: Omit<BrainProposal["changes"][number], "before">[]; sources: BrainProposal["sources"] }
    }
  | {
      action: "edit"
      project: string
      id: string
      digest: string
      request: { changes: Omit<BrainProposal["changes"][number], "before">[]; sources: BrainProposal["sources"] }
    }
  | { action: "cancel" | "apply"; project: string; id: string; digest: string }
