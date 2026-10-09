import { jsonSchema } from "ai"
import { Schema, SchemaIssue, Result } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { CaptureEntry, type CaptureSource } from "./capture-protocol"

function blocks(source: CaptureSource) {
  const clauses =
    source.user.text.length <= 1000
      ? Array.from(source.user.text.matchAll(/[^.!?]+(?:[.!?]+|$)/g)).flatMap((match) => {
          const text = match[0].trim()
          if (!/^(?:For [^.!?`]{1,120}, )?I (?:also )?(?:prefer|like|dislike|would prefer) [^.!?`]+[.!?]?$/i.test(text))
            return []
          const start = match.index + match[0].indexOf(text)
          return [{ start, end: start + text.length }]
        })
      : []
  const preferences = clauses.length >= 2 && clauses.length <= 4 ? clauses : []
  const rows = [
    { ...source.user, origin: "user_statement" },
    { ...source.assistant, origin: "assistant_interpretation" },
    ...source.tools.map((tool) => ({ ...tool, origin: "tool_observation" })),
  ].flatMap((row) => {
    const spans = []
    for (let start = 0; start < row.text.length; ) {
      const cuts = row.origin === "user_statement" ? preferences.flatMap((span) => [span.start, span.end]) : []
      const edge = Math.min(start + 1024, row.text.length, ...cuts.filter((cut) => cut > start))
      const end =
        edge < row.text.length && /[\uD800-\uDBFF]/.test(row.text[edge - 1]) && /[\uDC00-\uDFFF]/.test(row.text[edge])
          ? edge - 1
          : edge
      const preference =
        row.origin === "user_statement" && preferences.some((span) => span.start === start && span.end === end)
      spans.push({ ...row, text: row.text.slice(start, end), start, end, preference })
      start = end
    }
    return spans
  })
  if (!rows.length || rows.length > 64) throw new Error("Capture source reference bound exceeded")
  return rows.map((row, ref) => ({ ...row, ref }))
}

function preference(ref: number) {
  return Schema.Union([
    Schema.Struct({
      status: Schema.Literal("retained"),
      entry: Schema.Struct({
        ...CaptureEntry.fields,
        category: Schema.Literal("Preferences"),
        origin: Schema.Literal("user_statement"),
        evidence: Schema.Array(Schema.Struct({ ref: Schema.Literal(ref) })).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(1),
        ),
      }),
    }),
    Schema.Struct({
      status: Schema.Literal("excluded"),
      reason: Schema.Literals(["sensitive", "transient", "no_durable_fact"]),
    }),
  ])
}

function contract(source: CaptureSource) {
  const rows = blocks(source)
  const preferences = rows.filter((row) => row.preference)
  const origins = ["user_statement", "assistant_interpretation", "tool_observation"] as const
  const groups = origins.flatMap((origin) => {
    const refs = rows.filter((row) => !row.preference && row.origin === origin && row.text.trim()).map((row) => row.ref)
    if (!refs.length) return []
    return [
      Schema.Struct({
        ...CaptureEntry.fields,
        origin: Schema.Literal(origin),
        evidence: Schema.Array(
          Schema.Struct({
            ref: refs.length === 1 ? Schema.Literal(refs[0]) : Schema.Literals(refs),
          }),
        ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
      }),
    ]
  })
  const entries = Schema.Array(groups.length ? Schema.Union(groups) : Schema.Never).check(
    Schema.isMaxLength(8 - preferences.length),
  )
  if (!preferences.length) return Schema.Struct({ entries })
  return Schema.Struct({
    entries,
    preferences: Schema.Struct(
      Object.fromEntries(preferences.map((row) => [`preference_${row.ref}`, preference(row.ref)])),
    ),
  })
}
const log = Log.create({ service: "capture.extraction" })
const fields = new Set([
  "entries",
  "category",
  "key",
  "text",
  "origin",
  "evidence",
  "ref",
  "preferences",
  "status",
  "entry",
  "reason",
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Lift only disjoint intersections; no bound or object-property rule is discarded. */
function flatten(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(flatten)
  if (!record(value)) return value
  const next = Object.fromEntries(Object.entries(value).map(([key, value]) => [key, flatten(value)]))
  if (!Array.isArray(next.allOf)) return next
  const keys = new Set(Object.keys(next).filter((key) => key !== "allOf"))
  if (
    !next.allOf.every(
      (item) =>
        record(item) &&
        Object.keys(item).every((key) => {
          if (keys.has(key)) return false
          keys.add(key)
          return true
        }),
    )
  )
    return next
  const { allOf, ...rest } = next
  return Object.assign(rest, ...allOf)
}

function decode(value: unknown, source: CaptureSource) {
  const result = Schema.decodeUnknownResult(contract(source), { onExcessProperty: "error" })(value)
  if (Result.isSuccess(result)) return result.success
  const issues = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook: () => "invalid", checkHook: () => "invalid" })(
    result.failure.issue,
  )
  const paths = issues.issues
    .slice(0, 4)
    .map((issue) =>
      issue.path
        ?.slice(0, 6)
        .map((key) =>
          typeof key === "number" && Number.isSafeInteger(key) && key >= 0 && key <= 8
            ? key
            : typeof key === "string" && fields.has(key)
              ? key
              : "extra",
        ),
    )
  log.warn("capture schema rejected", { paths: JSON.stringify(paths) })
  throw new Error("Capture extraction does not match the bounded entry schema")
}

/** The model selects original source references; it never authors IDs or offsets. */
export function extraction(source: CaptureSource) {
  const cfg = contract(source)
  const schema = flatten(Schema.toJsonSchemaDocument(cfg).schema)
  if (!record(schema)) throw new Error("Capture generation requires an object schema")
  return jsonSchema<typeof cfg.Type>(schema, {
    validate: async (value) => {
      try {
        return { success: true, value: decode(value, source) }
      } catch {
        return { success: false, error: new Error("Capture extraction does not match the bounded entry schema") }
      }
    },
  })
}

export function extracted(value: unknown, source: CaptureSource) {
  const rows = blocks(source)
  const parsed = decode(value, source)
  const slots = "preferences" in parsed && record(parsed.preferences) ? parsed.preferences : undefined
  const preferences = rows
    .filter((row) => row.preference)
    .flatMap((row) => {
      if (!slots) throw new Error("Capture extraction is missing preference dispositions")
      const slot = Schema.decodeUnknownSync(preference(row.ref))(slots[`preference_${row.ref}`])
      return slot.status === "retained" ? [slot.entry] : []
    })
  return [...parsed.entries, ...preferences].map((entry) => ({
    ...entry,
    evidence: entry.evidence.map((evidence) => {
      const original = rows[evidence.ref]
      if (!original || original.origin !== entry.origin || !original.text.trim()) {
        log.warn("capture reference rejected", {
          ref: evidence.ref,
          origin: entry.origin,
          source: original?.origin,
          blank: !original?.text.trim(),
        })
        throw new Error("Capture evidence does not identify an actual original source reference")
      }
      return { id: original.id, start: original.start, end: original.end }
    }),
  }))
}

export function prepared(source: CaptureSource) {
  return JSON.stringify(
    blocks(source).map(({ start: _start, end: _end, preference, ...row }) => ({
      ...row,
      ...(preference ? { slot: `preference_${row.ref}` } : {}),
    })),
  )
}
