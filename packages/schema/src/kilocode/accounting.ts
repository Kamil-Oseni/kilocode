import { Schema } from "effect"
import { optional } from "../schema"

export const Accounting = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["reported", "estimated", "partial", "unknown"]),
  source: Schema.String,
  currency: optional(Schema.Literal("USD")),
  amount: optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  unit: optional(Schema.String),
  quantity: optional(Schema.Finite),
  buckets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      tokens: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      rate: optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  issues: Schema.Array(Schema.String),
}).annotate({ identifier: "Raya.Accounting" })
export interface Accounting extends Schema.Schema.Type<typeof Accounting> {}
