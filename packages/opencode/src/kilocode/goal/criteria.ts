import { Schema } from "effect"

const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Criterion = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
  description: Text,
  verification: Text,
})
export const Criteria = Schema.Array(Criterion).check(Schema.isMinLength(1), Schema.isMaxLength(20))
export type Criteria = typeof Criteria.Type

export const GoalCriteria = Schema.Array(
  Schema.Struct({
    ...Criterion.fields,
    required: Schema.optional(Schema.Boolean),
    review: Schema.optional(Schema.Boolean),
    check: Schema.optional(
      Schema.Struct({
        kind: Schema.Literal("command"),
        command: Text,
        directory: Text.check(Schema.isPattern(/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/)),
      }),
    ),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(20))
export type GoalCriteria = typeof GoalCriteria.Type
