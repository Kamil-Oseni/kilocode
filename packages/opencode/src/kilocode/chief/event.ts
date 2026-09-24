import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

/** Process-local invalidation hint. Clients must read the exact active plan for durable contents. */
export const ChiefNoteEvent = BusEvent.define(
  "raya.chief.note.available",
  Schema.Struct({
    version: Schema.Literal(1),
    sessionID: SessionID,
    goalCreatedAt: Schema.Number,
    requestID: Schema.String,
    revision: Schema.String,
    noteID: Schema.String,
  }),
)
