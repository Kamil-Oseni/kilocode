import { Schema } from "effect"
import { Event } from "../event"
import { SessionV1 } from "../v1/session"
import { SessionID } from "../session-id"

/** Replay retains the actual message and part, never local completion authority. */
export const Committed = Event.define({
  type: "raya.result.notice.committed",
  durable: { aggregate: "sessionID", version: 1 },
  schema: {
    sessionID: SessionID,
    info: SessionV1.User,
    part: SessionV1.TextPart,
    time: Schema.Int,
  },
})
