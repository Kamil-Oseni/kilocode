import type { ChildSteerResultMessage } from "../../types/messages"
import type { SessionStatus } from "../../types/messages/connection"

export type ChildSteerStage = "ready" | "working" | "accepted" | "failed"
export type ChildSteerDraft = {
  text: string
  stage: ChildSteerStage
  messageID?: string
  code?: "inactive" | "stale-run" | "changed-replay" | "not-found" | "unavailable"
  error?: string
}

export const steerKey = (parent: string, child: string) => `${parent}:${child}`
export const steerID = () => `msg_${crypto.randomUUID()}`

export function canSteer(status: SessionStatus | undefined, draft: ChildSteerDraft) {
  const text = draft.text.trim()
  return (
    (status === "busy" || status === "retry") && draft.stage !== "working" && text.length > 0 && text.length <= 32_000
  )
}

export function applySteerResult(drafts: Record<string, ChildSteerDraft>, message: ChildSteerResultMessage) {
  const key = steerKey(message.parentSessionID, message.childSessionID)
  const draft = drafts[key]
  if (!draft || draft.stage !== "working" || draft.messageID !== message.messageID) return drafts
  if (message.accepted) return { ...drafts, [key]: { text: "", stage: "accepted" } as ChildSteerDraft }
  return {
    ...drafts,
    [key]: { ...draft, stage: "failed", code: message.code, error: message.error } as ChildSteerDraft,
  }
}
