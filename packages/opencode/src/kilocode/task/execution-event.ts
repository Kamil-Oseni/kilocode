import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

// A process-local hint. Consumers must reread durable identity and queued intake before acting.
export const ExecutionIdle = BusEvent.define(
  "raya.routine.execution.idle",
  Schema.Struct({
    version: Schema.Literal(1),
    runID: Schema.String,
    agentID: Schema.String,
    sessionID: SessionID,
    execution: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
)
