import type { EditReviewResultMessage } from "../../types/messages/extension-messages"

export type ReviewRequest = {
  request: string
  session: string
  key?: string
  epoch: number
  file?: string
  revision?: string
  action?: "keep" | "undo"
}

export function ready(
  session: string | undefined,
  details: { session: string; expected?: Record<string, string> } | undefined,
) {
  return !!session && details?.session === session && !!details.expected && Object.keys(details.expected).length > 0
}

/** Reuse an attempt only while its action, scope, revision and session still match. */
export function retry(previous: ReviewRequest | undefined, next: Omit<ReviewRequest, "request">) {
  if (
    !previous ||
    previous.session !== next.session ||
    previous.key !== next.key ||
    previous.epoch !== next.epoch ||
    previous.file !== next.file ||
    previous.revision !== next.revision ||
    previous.action !== next.action
  )
    return
  return previous.request
}

/** Late acknowledgements must never accept a newer edit or another session. */
export function reviewResult(
  pending: ReviewRequest | undefined,
  result: EditReviewResultMessage,
  current: { session?: string; key?: string; epoch: number },
): "ignore" | "failed" | "stale" | "accept" {
  if (!pending || pending.request !== result.requestID || pending.session !== result.sessionID) return "ignore"
  if (result.error) return "failed"
  if (result.refreshOnly) return "stale"
  if (current.session !== pending.session || current.key !== pending.key || current.epoch !== pending.epoch)
    return "stale"
  return "accept"
}
