import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Question } from "@/question"
import { InvalidArgumentsError } from "@/tool/tool"
import { Suggestion } from "../suggestion"
import { SessionRetirement } from "./retirement"
import { Refusal } from "./tool-refusal"

/** Only canonical business refusals may settle after their durable terminal tool publication. */
export function completed(session: string, call: string, error: unknown) {
  if (
    !(error instanceof InvalidArgumentsError) &&
    !(error instanceof PermissionV1.DeniedError) &&
    !(error instanceof PermissionV1.RejectedError) &&
    !(error instanceof PermissionV1.CorrectedError) &&
    !(error instanceof Question.RejectedError) &&
    !(error instanceof Suggestion.DismissedError) &&
    !(error instanceof Refusal)
  )
    return false
  return SessionRetirement.completed(session, call, error)
}
