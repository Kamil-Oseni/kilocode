export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@opencode-ai/schema/permission-v1"
import { ID } from "@opencode-ai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    // kilocode_change start - Auto and other agents own deny rules (source: "agent").
    // Blaming "the user" for those is wrong and makes a successful delegated /goal
    // turn look like the user blocked the tool.
    const items = Array.isArray(this.ruleset) ? this.ruleset : this.ruleset != null ? [this.ruleset] : []
    const agent = items.some(
      (item) => item && typeof item === "object" && (item as { source?: unknown }).source === "agent",
    )
    if (agent) {
      return `This agent is not allowed to use this tool directly. Delegate the work with the task tool instead of calling it yourself. Relevant rules: ${JSON.stringify(this.ruleset)}`
    }
    // kilocode_change end
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError
