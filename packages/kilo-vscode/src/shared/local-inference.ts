/** Ephemeral observations of primary requests; never persisted execution authority. */
export type LocalInferenceSnapshot = {
  version: 1
  sessionID: string
  epoch: string
  observedAt: number
  requests: { messageID: string; queued: number; active: number; since?: number }[]
}
