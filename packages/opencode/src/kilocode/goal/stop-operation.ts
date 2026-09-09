import { Schema } from "effect"
import { MessageID } from "@/session/schema"

const target = {
  id: Schema.String,
  jobID: Schema.String,
  revision: Schema.String,
  messageID: Schema.optional(MessageID),
  at: Schema.Number,
}

export const Operation = Schema.Union([
  Schema.Struct({ ...target, phase: Schema.Literal("requested") }),
  Schema.Struct({
    ...target,
    phase: Schema.Literal("observed"),
    observedAt: Schema.Number,
    result: Schema.Literals(["accepted", "not-selected", "cancelled", "completed", "error", "running"]),
  }),
])
export type Operation = typeof Operation.Type
