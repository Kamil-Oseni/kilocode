import { LLMError } from "@opencode-ai/llm"
import { SessionV1 } from "@opencode-ai/core/v1/session"

/** Preserve native transport classification and its original failure when publishing session errors. */
export function overflow(err: unknown) {
  if (!(err instanceof LLMError) || err.reason._tag !== "InvalidRequest") return undefined
  if (err.reason.classification !== "context-overflow") return undefined
  return new SessionV1.ContextOverflowError(
    { message: err.reason.message, responseBody: err.reason.http?.body },
    { cause: err },
  ).toObject()
}
