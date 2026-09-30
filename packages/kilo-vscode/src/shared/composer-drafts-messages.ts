import type { ReviewCommentEntry } from "./review-comments"

export type DraftToken = { generation: string; revision: number }
export type DraftIdentity = {
  key: string
  box: string
  workspace: string
  projectID?: string
  sessionID?: string
  pendingID?: string
}
/** Paths and project ownership are supplied by the host, never the pane. */
export type DraftTarget = Omit<DraftIdentity, "workspace" | "projectID"> & { projectID?: string }
export type DraftContent = {
  text: string
  comments: ReviewCommentEntry[]
  images: Array<{
    id: string
    filename: string
    mime: string
    dataUrl: string
  }>
  scroll: number
  selection?: { start: number; end: number }
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
}
export type DraftEntry = {
  identity: DraftIdentity
  token: DraftToken
  content: DraftContent | null
  mutation: string
  digest: string
  receipt?: { request: string }
}
export type DraftCapture = {
  identity: DraftTarget
  token: DraftToken
  mutation: string
  digest: string
  epoch: string
  generation: number
  owner: string
}
export type DraftCode =
  | "invalid"
  | "scope"
  | "corrupt"
  | "missing"
  | "conflict"
  | "capacity"
  | "admission"
  | "disconnected"
  | "stale"
  | "timeout"
  | "changed"
  | "promotion"
  | "uncertain"
  | "unavailable"
type Correlation = { requestID: string; epoch: string; generation: number }
export type ComposerDraftRequest = Correlation & { owner: string } & (
    | { type: "composerDraftList"; box: string }
    | { type: "composerDraftLoad"; identity: DraftTarget }
    | {
        type: "composerDraftSave"
        identity: DraftTarget
        expected?: DraftToken
        content: DraftContent
        mutation: string
        reviewed?: boolean
      }
    | { type: "composerDraftClear"; identity: DraftTarget; expected: DraftToken; mutation: string }
    | {
        type: "composerDraftPromote"
        from: DraftTarget
        to: DraftTarget
        source: DraftToken
        target?: DraftToken
        mutation: string
      }
  )
export type ComposerDraftPane = { type: "composerDraftPane"; epoch: string; active: boolean }
export type ComposerDraftResult = Correlation & {
  owner: string
  type: "composerDraftResult"
  operation: ComposerDraftRequest["type"]
  entry?: DraftEntry | null
  entries?: DraftEntry[]
  source?: DraftEntry
  target?: DraftEntry
  error?: DraftCode
}
export type ComposerDraftState = {
  type: "composerDraftState"
  epoch: string
  generation: number
  connected: boolean
  owners: Array<{ box: string; owner: string }>
}
export type ComposerDraftFlush = {
  type: "composerDraftFlush"
  requestID: string
  epoch: string
  generation: number
  deadline: number
}
export type ComposerDraftFlushed = Correlation & {
  type: "composerDraftFlushed"
  committed: boolean
  entries: Array<{ identity: DraftTarget; token: DraftToken; mutation: string; digest: string; owner: string }>
  error?: DraftCode
}
export type ComposerDraftAccepted = {
  type: "composerDraftAccepted"
  epoch: string
  generation: number
  sessionID: string
  messageID: string
  capture: DraftCapture
  entry?: DraftEntry
  error?: DraftCode
}
export type ComposerDraftPrepared = {
  type: "composerDraftPrepared"
  epoch: string
  generation: number
  sessionID: string
  messageID: string
  capture: DraftCapture
  entry: DraftEntry
}
export type ComposerDraftWebviewMessage = ComposerDraftRequest | ComposerDraftPane | ComposerDraftFlushed
export type ComposerDraftExtensionMessage =
  | ComposerDraftResult
  | ComposerDraftState
  | ComposerDraftFlush
  | ComposerDraftAccepted
  | ComposerDraftPrepared
