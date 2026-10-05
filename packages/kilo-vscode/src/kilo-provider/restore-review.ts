import type { KiloClient } from "@kilocode/sdk/v2/client"
import { Approval, Review } from "../shared/restore-review"
import { getErrorMessage } from "../kilo-provider-utils"

export async function restoreReview(input: {
  message: { type: string } & Record<string, unknown>
  client: KiloClient | null
  directory: string
  post: (message: unknown) => void
  current?: () => boolean
}) {
  const message = input.message
  if (message.type !== "restoreReviewGet" && message.type !== "restoreReviewApprove") return false
  if (typeof message.requestID !== "string" || !message.requestID || message.requestID.length > 128) return true
  try {
    if (!input.client || input.current?.() === false) throw new Error("Reconnect and reload this profile's review.")
    const response =
      message.type === "restoreReviewGet"
        ? await input.client.kilocode.profile.restoreReview({ directory: input.directory }, { throwOnError: true })
        : await input.client.kilocode.profile.restoreApprove(
            { directory: input.directory, ...Approval.parse(message.approval) },
            { throwOnError: true },
          )
    if (input.current?.() === false) throw new Error("This view changed. Reload the profile's current review.")
    input.post({ type: "restoreReviewResult", requestID: message.requestID, summary: Review.parse(response.data) })
  } catch (err) {
    input.post({
      type: "restoreReviewResult",
      requestID: message.requestID,
      error: getErrorMessage(err) || "The profile review was not confirmed. Reload it before trying again.",
    })
  }
  return true
}
