import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { utils, write, type CellObject, type WorkSheet } from "xlsx"
import { batchMutations, enabled, ensureDirectory } from "@kilocode/sandbox"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import { assertMutablePath } from "@/kilocode/agent-manager/protection"
import * as Artifact from "@/kilocode/goal/artifact"
import * as Tool from "@/tool/tool"

const Scalar = Schema.Union([Schema.String.check(Schema.isMaxLength(32_767)), Schema.Finite, Schema.Boolean])
const Formula = Schema.Struct({
  formula: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)).annotate({
    description:
      "A same-sheet Excel formula without a leading equals sign. Supports arithmetic, comparisons, cell/range references and the documented safe functions.",
  }),
  value: Scalar.annotate({ description: "Required cached display value; Excel recalculates the formula when opened." }),
})
const DateCell = Schema.Struct({
  date: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(10)).annotate({
    description: "A calendar date from 1900-01-01 through 9999-12-31 in exact YYYY-MM-DD form.",
  }),
})
const Cell = Schema.Union([Scalar, Schema.Null, Formula, DateCell])
const Sheet = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(31)),
  rows: Schema.Array(Schema.Array(Cell).check(Schema.isMaxLength(200))).check(Schema.isMaxLength(50_000)),
  header: Schema.optional(Schema.Boolean),
})
const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Destination path ending in .xlsx." }),
  sheets: Schema.Array(Sheet).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
})

type Value = typeof Cell.Type

const functions = new Set([
  "ABS",
  "AND",
  "AVERAGE",
  "COUNT",
  "COUNTA",
  "IF",
  "MAX",
  "MIN",
  "NOT",
  "OR",
  "ROUND",
  "ROUNDDOWN",
  "ROUNDUP",
  "SUM",
])

function formula(value: string) {
  const text = value.trim()
  if (!text || text.startsWith("=") || !/^[A-Za-z0-9$():,.+\-*/%^<>= \t]+$/.test(text))
    throw new Error("Formulas must omit the leading = and use only safe same-sheet references and operators.")
  const plain = text.replaceAll("$", "")
  for (const match of plain.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
    const token = match[0]!.toUpperCase()
    const rest = plain.slice(match.index! + match[0]!.length).trimStart()
    if (/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(token)) {
      const address = utils.decode_cell(token)
      if (address.c <= 16_383 && address.r <= 1_048_575) continue
      throw new Error(`Formula cell reference ${match[0]} is outside Excel's worksheet bounds.`)
    }
    if (token === "TRUE" || token === "FALSE") continue
    if (rest.startsWith("(") && functions.has(token)) continue
    throw new Error(`Formula token ${match[0]} is not a supported function or cell reference.`)
  }
  return text
}

function date(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error("Spreadsheet dates must use exact YYYY-MM-DD form.")
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const time = Date.UTC(year, month - 1, day)
  const parsed = new Date(time)
  if (
    year < 1900 ||
    year > 9999 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    throw new Error("Spreadsheet date is not a valid calendar day from 1900-01-01 through 9999-12-31.")
  return time / 86_400_000 + 25_569 - (time < Date.UTC(1900, 2, 1) ? 1 : 0)
}

function scalar(value: Value) {
  if (typeof value !== "object" || value === null) return value
  if ("formula" in value) return value.value
  return value.date
}

function cell(value: Value): string | number | boolean | null | CellObject {
  if (typeof value !== "object" || value === null) return value
  if ("date" in value) return { t: "n", v: date(value.date), z: "yyyy-mm-dd" }
  const cached = value.value
  return {
    f: formula(value.formula),
    v: cached,
    t: typeof cached === "number" ? "n" : typeof cached === "boolean" ? "b" : "s",
  }
}

function columns(sheet: WorkSheet, rows: ReadonlyArray<ReadonlyArray<Value>>) {
  const count = rows.reduce((max, row) => Math.max(max, row.length), 0)
  sheet["!cols"] = Array.from({ length: count }, (_, index) => ({
    wch: Math.min(
      40,
      Math.max(8, ...rows.slice(0, 1_000).map((row) => String(scalar(row[index] ?? null) ?? "").length + 2)),
    ),
  }))
}

export const CreateSpreadsheetTool = Tool.define(
  "create_spreadsheet",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Create a real Excel .xlsx workbook from structured values, timezone-safe YYYY-MM-DD calendar dates and safe same-sheet formulas. Formula objects require formula without a leading = plus a cached string, number or boolean value. Supported functions are SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ROUNDUP, ROUNDDOWN, ABS, IF, AND, OR and NOT; formulas cannot use external links, named ranges or string literals. Supports up to 10 named sheets, 50,000 rows per sheet, 200 columns per row and 200,000 cells total. Returns a verified local artifact receipt. Raya does not calculate formulas; Excel recalculates them when opened. It does not run macros, import templates or preserve an existing workbook.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          if (path.extname(filepath).toLowerCase() !== ".xlsx") throw new Error("Choose a destination ending in .xlsx.")
          const names = params.sheets.map((sheet) => sheet.name.trim())
          if (names.some((name) => !name || /[\\/:?*[\]]/.test(name) || name.startsWith("'") || name.endsWith("'")))
            throw new Error("Sheet names must be valid Excel names with 1 to 31 characters.")
          if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
            throw new Error("Each sheet needs a unique name.")
          const cells = params.sheets.reduce((sum, sheet) => sum + sheet.rows.reduce((n, row) => n + row.length, 0), 0)
          if (cells > 200_000) throw new Error("This workbook exceeds the 200,000-cell limit.")
          const formulas = params.sheets.reduce(
            (sum, sheet) =>
              sum +
              sheet.rows.reduce(
                (count, row) =>
                  count +
                  row.filter((value) => typeof value === "object" && value !== null && "formula" in value).length,
                0,
              ),
            0,
          )
          const dates = params.sheets.reduce(
            (sum, sheet) =>
              sum +
              sheet.rows.reduce(
                (count, row) =>
                  count + row.filter((value) => typeof value === "object" && value !== null && "date" in value).length,
                0,
              ),
            0,
          )
          for (const sheet of params.sheets)
            for (const row of sheet.rows)
              for (const value of row) {
                if (typeof value !== "object" || value === null) continue
                if ("formula" in value) formula(value.formula)
                if ("date" in value) date(value.date)
              }
          assertMutablePath(filepath)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          const exists = yield* fs.existsSafe(filepath)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              exists,
              format: "xlsx",
              formulas,
              dates,
              sheets: names.map((name, index) => ({ name, rows: params.sheets[index]!.rows.length })),
            },
          })
          const bytes = yield* Effect.try({
            try: () => {
              const book = utils.book_new()
              for (const [index, input] of params.sheets.entries()) {
                const sheet = utils.aoa_to_sheet(input.rows.map((row) => row.map(cell)))
                columns(sheet, input.rows)
                if (input.header !== false && input.rows.length && input.rows[0]!.length)
                  sheet["!autofilter"] = { ref: sheet["!ref"]! }
                utils.book_append_sheet(book, sheet, names[index])
              }
              return new Uint8Array(write(book, { type: "buffer", bookType: "xlsx", compression: true }))
            },
            catch: (cause) => new Error(`Raya couldn't create this workbook: ${String(cause)}`),
          })
          const tmp = `${filepath}.raya-${randomUUID()}.tmp`
          const save = Effect.gen(function* () {
            if (!(yield* enabled)) {
              yield* fs.writeWithDirs(tmp, bytes)
              yield* fs.rename(tmp, filepath)
              return
            }
            yield* batchMutations(
              Effect.gen(function* () {
                yield* ensureDirectory(fs, path.dirname(filepath))
                yield* fs.writeFile(tmp, bytes)
                yield* fs.rename(tmp, filepath)
              }),
            )
          }).pipe(Effect.ensuring(fs.remove(tmp).pipe(Effect.ignore)))
          yield* save
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: exists ? "change" : "add" })
          const revision = yield* Artifact.capture(fs, filepath)
          return {
            title: path.relative(instance.worktree, filepath),
            output: `Created ${names.length === 1 ? "1 sheet" : `${names.length} sheets`} in ${path.basename(filepath)}.`,
            metadata: { filepath, exists, sheets: names, cells, formulas, dates, rayaRevision: revision },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
