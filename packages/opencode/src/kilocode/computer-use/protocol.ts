// raya_change - shared Computer Use observation and action evidence contract
import { Schema } from "effect"

const Time = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

export const ProtocolVersion = Schema.Literal(1)
export const ObservationVersion = Schema.Literal(2)
export const ObservationID = Identity.pipe(Schema.brand("ComputerUseObservationID")).annotate({
  identifier: "ComputerUseObservationID",
})
export type ObservationID = Schema.Schema.Type<typeof ObservationID>

export const Target = Schema.Struct({
  surface: Schema.Literals(["browser", "desktop", "mobile"]),
  windowID: Identity,
  documentID: Schema.optional(Identity),
  location: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
}).annotate({ identifier: "ComputerUseTarget" })

const ObservationV1 = Schema.Struct({
  version: ProtocolVersion,
  id: ObservationID,
  observedAt: Time,
  validUntil: Time,
  target: Target,
})

const ObservationV2 = Schema.Struct({
  version: ObservationVersion,
  id: ObservationID,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  sceneVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  observedAt: Time,
  validUntil: Time,
  target: Target,
})

export const Observation = Schema.Union([ObservationV1, ObservationV2]).annotate({
  identifier: "ComputerUseObservation",
})
export type Observation = Schema.Schema.Type<typeof Observation>

export const Receipt = Schema.Struct({
  version: ProtocolVersion,
  requestID: Identity,
  startedAt: Time,
  finishedAt: Time,
  effect: Schema.Literals(["observe", "navigate", "interact", "manage", "transfer", "authenticate", "test"]),
  outcome: Schema.Literals(["confirmed", "unknown"]),
  target: Schema.optional(Target),
  observationID: Schema.optional(ObservationID),
}).annotate({ identifier: "ComputerUseReceipt" })
export type Receipt = Schema.Schema.Type<typeof Receipt>
