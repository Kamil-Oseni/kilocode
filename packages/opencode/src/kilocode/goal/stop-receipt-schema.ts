import { Schema } from "effect"
import { SessionID } from "@/session/schema"
import { Observation } from "./stop-jobs"
import { Operation } from "./stop-operation"
import { Trigger } from "@/kilocode/task/trigger"
import { Codec } from "@/kilocode/task/schema"

export const TaskRetirement = Schema.Struct({
  version: Schema.Literal(1),
  stop: Schema.optional(Codec.Stop),
  sessionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      agentID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      sessionID: SessionID,
      executionDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
      at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
      scheduleVersion: Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
      ),
      trigger: Schema.optional(
        Trigger.check(
          Schema.makeFilter((value) =>
            JSON.stringify(value).length <= 4096 ? undefined : "Routine stop trigger is too large.",
          ),
        ),
      ),
    }),
  ).check(Schema.isMaxLength(1)),
})
export type TaskRetirement = typeof TaskRetirement.Type

export const Receipt = Schema.Struct({
  sessionID: SessionID,
  intent: Schema.String,
  phase: Schema.Literals(["requested", "cleared", "finished"]),
  at: Schema.Number,
  finishedAt: Schema.optional(Schema.Number),
  interrupted: Schema.optional(Schema.Boolean),
  background: Schema.optional(Observation),
  operations: Schema.optional(Schema.Array(Operation)),
  task: Schema.optional(TaskRetirement),
})
export type Receipt = typeof Receipt.Type
