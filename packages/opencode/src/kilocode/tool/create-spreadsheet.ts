import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { utils, write, type WorkSheet } from "xlsx"
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

const Cell = Schema.Union([Schema.String.check(Schema.isMaxLength(32_767)), Schema.Finite, Schema.Boolean, Schema.Null])
const Sheet = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(31)),
  rows: Schema.Array(Schema.Array(Cell).check(Schema.isMaxLength(200))).check(Schema.isMaxLength(50_000)),
  header: Schema.optional(Schema.Boolean),
})
const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Destination path ending in .xlsx." }),
  sheets: Schema.Array(Sheet).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
})

function columns(sheet: WorkSheet, rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>) {
  const count = rows.reduce((max, row) => Math.max(max, row.length), 0)
  sheet["!cols"] = Array.from({ length: count }, (_, index) => ({
    wch: Math.min(40, Math.max(8, ...rows.slice(0, 1_000).map((row) => String(row[index] ?? "").length + 2))),
  }))
}

export const CreateSpreadsheetTool = Tool.define(
  "create_spreadsheet",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Create a real Excel .xlsx workbook from structured cell values. Supports up to 10 named sheets, 50,000 rows per sheet, 200 columns per row and 200,000 cells total. Returns a verified local artifact receipt. It does not evaluate formulas, run macros, import templates or preserve an existing workbook.",
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
              sheets: names.map((name, index) => ({ name, rows: params.sheets[index]!.rows.length })),
            },
          })
          const bytes = yield* Effect.try({
            try: () => {
              const book = utils.book_new()
              for (const [index, input] of params.sheets.entries()) {
                const sheet = utils.aoa_to_sheet(input.rows)
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
            metadata: { filepath, exists, sheets: names, cells, rayaRevision: revision },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
