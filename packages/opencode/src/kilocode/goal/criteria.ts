import { Schema } from "effect"

const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
const Path = Schema.String.check(Schema.isMaxLength(4000), Schema.isPattern(/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/))
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
export const SourceRead = Schema.Struct({
  kind: Schema.Literal("source-read"),
  path: Path,
  canonical: Path,
  sha256: Equality.fields.source.fields.sha256,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8192)),
}).annotate({
  description:
    "Require this worker's fresh full native Read of an explicitly pinned source file for Goal completion and, in contracted Routines, before handoff. This grants no Read permission and proves acquisition of the saved bytes, not their factual accuracy.",
  parseOptions: { onExcessProperty: "error" },
})
export type SourceRead = typeof SourceRead.Type
const Criterion = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
  description: Text,
  verification: Text,
  check: Schema.optional(Schema.Union([FileContent, SourceRead])),
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
        SourceRead,
      ]),
    ),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(20))
export type GoalCriteria = typeof GoalCriteria.Type
