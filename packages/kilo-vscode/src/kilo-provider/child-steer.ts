import type { KiloClient } from "@kilocode/sdk/v2/client"

export type ChildSteerMessage = {
  type: "steerChildSession"
  parentSessionID: string
  childSessionID: string
  messageID: string
  text: string
}

type Post = (message: unknown) => void

export const childDirectory = (routed: string | null | undefined, tracked: string | undefined) => {
  if (routed === null) return undefined
  return routed ?? tracked
}

const failure = (input: ChildSteerMessage, post: Post, code: string | undefined, error: string) =>
  post({
    type: "childSteerResult",
    parentSessionID: input.parentSessionID,
    childSessionID: input.childSessionID,
    messageID: input.messageID,
    accepted: false,
    code,
    error,
  })

const issue = (value: unknown) => {
  if (!value || typeof value !== "object") return {}
  const error = value as { code?: unknown; message?: unknown }
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
  }
}

export async function steerChild(input: {
  client: KiloClient
  directory: string
  message: ChildSteerMessage
  post: Post
}) {
  const message = input.message
  const text = message.text.trim()
  if (
    !message.parentSessionID ||
    !message.childSessionID ||
    message.parentSessionID === message.childSessionID ||
    !message.messageID ||
    !text ||
    text.length > 32_000
  ) {
    failure(message, input.post, "unavailable", "This instruction is invalid. Review it and try again.")
    return
  }

  const attempt = await input.client.kilocode.session
    .childSteer({
      parentSessionID: message.parentSessionID,
      childSessionID: message.childSessionID,
      directory: input.directory,
      messageID: message.messageID,
      text,
    })
    .then(
      (result) => ({ type: "result" as const, result }),
      (error: unknown) => ({ type: "error" as const, error }),
    )
  if (attempt.type === "error") {
    failure(message, input.post, "unavailable", "Couldn't send the instruction. Your text is still here. Try again.")
    return
  }

  const result = attempt.result
  if (
    result.data &&
    result.data.parentSessionID === message.parentSessionID &&
    result.data.childSessionID === message.childSessionID &&
    result.data.messageID === message.messageID
  ) {
    input.post({ type: "childSteerResult", ...result.data, accepted: true })
    return
  }

  const error = issue(result.error)
  if (result.response.status === 404) {
    failure(message, input.post, "not-found", "This sub-agent is no longer available from this conversation.")
    return
  }
  if (result.response.status === 409) {
    const code = ["inactive", "stale-run", "changed-replay"].includes(error.code ?? "") ? error.code : "unavailable"
    failure(
      message,
      input.post,
      code,
      error.message ?? "Couldn't send the instruction. Your text is still here. Try again.",
    )
    return
  }
  failure(message, input.post, "unavailable", "Couldn't send the instruction. Your text is still here. Try again.")
}
