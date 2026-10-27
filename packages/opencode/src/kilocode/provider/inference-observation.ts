import { Schema } from "effect"
import { MessageID, SessionID } from "@/session/schema"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(9))
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: SessionID,
  epoch: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)),
  observedAt: Time,
  requests: Schema.Array(
    Schema.Struct({
      messageID: MessageID,
      queued: Count,
      active: Count,
      since: Schema.optional(Time),
    }),
  ).check(Schema.isMaxLength(9)),
})
export type Snapshot = typeof Snapshot.Type
