import { Schema } from "effect"

const Timestamp = Schema.Number.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))

export const Trigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("timer"),
    id: Schema.String,
    scheduledAt: Timestamp,
    observedAt: Timestamp,
    tz: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    source: Schema.String,
    filter: Schema.optional(Schema.String),
    receivedAt: Timestamp,
  }),
])
