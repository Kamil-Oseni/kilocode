import { Schema } from "effect"

const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Path = Text.check(Schema.isPattern(/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/))
export const Equality = Schema.Struct({
  kind: Schema.Literal("byte-equality"),
  source: Schema.Struct({
    path: Path,
    canonical: Path,
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  }),
  target: Schema.Struct({ path: Path, canonical: Path }),
})
export type Equality = typeof Equality.Type
export const FileContent = Schema.Struct({
  kind: Schema.Literal("file-content"),
  path: Path,
  literals: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
})
  .check(
    Schema.makeFilter((value) =>
      value.literals.every((text) => Buffer.from(text, "utf8").toString("utf8") === text) &&
      value.literals.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0) <= 8192
        ? undefined
        : "File-content literals require valid UTF-8 and at most 8192 bytes in total.",
    ),
  )
  .annotate({
    description:
      "Verify explicitly required exact text in one declared output file using this worker's fresh full native Read. The checked file must fit within 8192 UTF-8 bytes. This checks literal presence, not factual accuracy or Markdown semantics.",
    parseOptions: { onExcessProperty: "error" },
  })
export type FileContent = typeof FileContent.Type
const Criterion = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
  description: Text,
  verification: Text,
  check: Schema.optional(FileContent),
})
export const Criteria = Schema.Array(Criterion).check(Schema.isMinLength(1), Schema.isMaxLength(20))
export type Criteria = typeof Criteria.Type

export const GoalCriteria = Schema.Array(
  Schema.Struct({
    ...Criterion.fields,
    required: Schema.optional(Schema.Boolean),
    review: Schema.optional(Schema.Boolean),
    check: Schema.optional(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("command"), command: Text, directory: Path }),
        Equality,
        FileContent,
      ]),
    ),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(20))
export type GoalCriteria = typeof GoalCriteria.Type
