import { Schema } from "effect"

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Key = Schema.String.check(Schema.isMaxLength(128))
export const Reconciliation = Schema.Struct({
  version: Schema.Literal(1),
  cycle: Count,
  high: Key,
  after: Schema.optional(Key),
  status: Schema.Literals(["running", "failed", "complete"]),
  scanned: Count,
  receipts: Count,
  quarantined: Count,
  updatedAt: Schema.Finite,
  failure: Schema.optional(
    Schema.Struct({
      id: Key,
      message: Schema.String.check(Schema.isMaxLength(240)),
    }),
  ),
})
export type Reconciliation = typeof Reconciliation.Type
