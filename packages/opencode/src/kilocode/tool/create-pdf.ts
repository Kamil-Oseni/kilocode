import { randomUUID } from "node:crypto"
import path from "node:path"
import { batchMutations, enabled, ensureDirectory } from "@kilocode/sandbox"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Effect, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { assertMutablePath } from "@/kilocode/agent-manager/protection"
import * as Artifact from "@/kilocode/goal/artifact"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import * as Tool from "@/tool/tool"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
const Cell = Schema.String.check(Schema.isMaxLength(300))
const Block = Schema.Union([
  Schema.Struct({ type: Schema.Literal("paragraph"), text: Text }),
  Schema.Struct({
    type: Schema.Literal("heading"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
    level: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3)),
  }),
  Schema.Struct({
    type: Schema.Literals(["bullets", "numbered"]),
    items: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("table"),
    rows: Schema.Array(Schema.Array(Cell).check(Schema.isMinLength(1), Schema.isMaxLength(8))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
    header: Schema.optional(Schema.Boolean),
  }),
])
const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Destination path ending in .pdf." }),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
  author: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  accent: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9A-Fa-f]{6}$/)).annotate({
      description: "Optional six-digit RGB accent without #. Defaults to Raya's 45557A.",
    }),
  ),
  blocks: Schema.Array(Block).check(Schema.isMinLength(1), Schema.isMaxLength(300)),
})

const extras = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x2c6, 0x88],
  [0x2030, 0x89],
  [0x160, 0x8a],
  [0x2039, 0x8b],
  [0x152, 0x8c],
  [0x17d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x2dc, 0x98],
  [0x2122, 0x99],
  [0x161, 0x9a],
  [0x203a, 0x9b],
  [0x153, 0x9c],
  [0x17e, 0x9e],
  [0x178, 0x9f],
])

function encode(value: string) {
  const bytes: number[] = []
  for (const char of value) {
    const code = char.codePointAt(0)!
    const mapped = extras.get(code)
    if (mapped !== undefined) {
      bytes.push(mapped)
      continue
    }
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code)
      continue
    }
    throw new Error(`PDF text contains an unsupported character: ${char}`)
  }
  return bytes
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
}

function wrap(value: string, size: number, indent = 0, width = 504 - indent) {
  const limit = Math.max(1, Math.floor(width / (size * 0.52)))
  const lines: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (!words.length) {
      lines.push("")
      continue
    }
    for (const word of words) {
      const parts = Array.from({ length: Math.ceil(word.length / limit) }, (_, index) =>
        word.slice(index * limit, (index + 1) * limit),
      )
      for (const part of parts) {
        const current = lines.at(-1)
        if (current !== undefined && current && `${current} ${part}`.length <= limit) {
          lines[lines.length - 1] = `${current} ${part}`
          continue
        }
        lines.push(part)
      }
    }
  }
  return lines
}

type Row =
  | { text: string; size: number; font: "F1" | "F2"; indent?: number; before?: number; after?: number }
  | { cells: readonly string[]; header: boolean; before?: number; after?: number }

function pdf(input: typeof Parameters.Type) {
  const rows: Row[] = []
  if (input.title) rows.push({ text: input.title.trim(), size: 28, font: "F1", after: 18 })
  for (const block of input.blocks) {
    if (block.type === "heading") {
      const size = block.level === 1 ? 22 : block.level === 2 ? 18 : 15
      rows.push({ text: block.text.trim(), size, font: "F1", before: block.level === 1 ? 14 : 10, after: 6 })
      continue
    }
    if (block.type === "paragraph") {
      rows.push({ text: block.text.trim(), size: 11, font: "F2", after: 9 })
      continue
    }
    if (block.type === "table") {
      for (const [index, cells] of block.rows.entries())
        rows.push({
          cells,
          header: index === 0 && block.header !== false,
          before: index === 0 ? 8 : 0,
          after: index === block.rows.length - 1 ? 9 : 0,
        })
      continue
    }
    for (const [index, item] of block.items.entries())
      rows.push({
        text: `${block.type === "numbered" ? `${index + 1}.` : "•"} ${item.trim()}`,
        size: 11,
        font: "F2",
        indent: 18,
        after: 3,
      })
    rows.at(-1)!.after = 9
  }

  const pages: string[][] = [[]]
  const accent = input.accent ?? "45557A"
  const rgb = [0, 2, 4].map((index) => (Number.parseInt(accent.slice(index, index + 2), 16) / 255).toFixed(3))
  let y = 720
  for (const [index, row] of rows.entries()) {
    y -= row.before ?? 0
    if ("cells" in row) {
      const width = 504 / row.cells.length
      const cells = row.cells.map((cell) => wrap(cell.trim(), 9, 0, width - 12))
      const height = Math.max(1, ...cells.map((lines) => lines.length)) * 12.15 + 10
      if (y - height < 72) {
        pages.push([])
        y = 720
      }
      const page = pages.at(-1)!
      if (row.header) page.push(`0.945 0.949 0.957 rg 54 ${(y - height).toFixed(2)} 504 ${height.toFixed(2)} re f`)
      for (const [column, lines] of cells.entries()) {
        const x = 54 + column * width
        page.push(
          `0.710 0.733 0.776 RG 0.5 w ${x.toFixed(2)} ${(y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`,
        )
        for (const [line, text] of lines.entries()) {
          if (!text) continue
          page.push(
            `BT /${row.header ? "F1" : "F2"} 9 Tf 0.090 0.102 0.129 rg ${(x + 6).toFixed(2)} ${(y - 14 - line * 12.15).toFixed(2)} Td <${encode(text)}> Tj ET`,
          )
        }
      }
      y -= height + (row.after ?? 0)
      continue
    }
    const lines = wrap(row.text, row.size, row.indent)
    for (const line of lines) {
      const height = row.size * 1.35
      if (y - height < 72) {
        pages.push([])
        y = 720
      }
      if (line) {
        const x = 54 + (row.indent ?? 0)
        pages
          .at(-1)!
          .push(`BT /${row.font} ${row.size} Tf 0.090 0.102 0.129 rg ${x} ${y.toFixed(2)} Td <${encode(line)}> Tj ET`)
      }
      y -= height
    }
    if (input.title && index === 0) pages.at(-1)!.push(`${rgb.join(" ")} rg 54 ${(y + 4).toFixed(2)} 504 2 re f`)
    y -= row.after ?? 0
  }
  if (pages.length > 200) throw new Error("This PDF exceeds the 200-page limit.")
  for (const [index, page] of pages.entries())
    page.push(`BT /F2 9 Tf 0.451 0.486 0.549 rg 540 36 Td <${encode(String(index + 1))}> Tj ET`)

  const objects: string[] = [
    "",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  const info = objects.push(
    `<< /Title <${encode(input.title?.trim() ?? path.basename(input.filePath))}> /Author <${encode(input.author?.trim() ?? "Raya")}> /Producer <${encode("Raya")}> >>`,
  )
  const kids: number[] = []
  for (const page of pages) {
    const stream = page.join("\n")
    const content = objects.push(
      `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
    )
    const id = objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`,
    )
    kids.push(id)
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>"
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] >>`

  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.7\n%Raya\n")]
  const offsets = [0]
  let length = parts[0]!.length
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const bytes = encoder.encode(`${index + 1} 0 obj\n${object}\nendobj\n`)
    parts.push(bytes)
    length += bytes.length
  }
  const xref = length
  const table = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  ].join("")
  parts.push(encoder.encode(table))
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return { bytes: output, pages: pages.length }
}

export const CreatePdfTool = Tool.define(
  "create_pdf",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Create a real paginated PDF from a title and structured headings, paragraphs, lists or rectangular tables. Tables support up to 8 columns and 100 rows each, with an optional first-row header. The writer supports printable WinAnsi text, creates at most 200 pages and returns a verified local artifact receipt. It creates a new PDF or replaces the whole destination after approval. It does not import or edit an existing PDF, embed images or custom fonts, create forms, add links, or guarantee archival conformance.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          if (path.extname(filepath).toLowerCase() !== ".pdf") throw new Error("Choose a destination ending in .pdf.")
          const text = params.blocks.flatMap((block) =>
            block.type === "table" ? block.rows.flat() : "items" in block ? block.items : [block.text],
          )
          const values = [params.title, params.author, ...text].filter((value): value is string => value !== undefined)
          const required = [
            params.title,
            params.author,
            ...params.blocks.flatMap((block) =>
              block.type === "table" ? [] : "items" in block ? block.items : [block.text],
            ),
          ].filter((value): value is string => value !== undefined)
          if (required.some((value) => !value.trim())) throw new Error("PDF text can't be blank.")
          const tables = params.blocks.filter((block) => block.type === "table")
          let cells = 0
          for (const table of tables) {
            const columns = table.rows[0]!.length
            if (table.rows.some((row) => row.length !== columns)) throw new Error("PDF table rows must be rectangular.")
            if (!table.rows.some((row) => row.some((cell) => cell.trim())))
              throw new Error("A PDF table must contain visible text.")
            cells += table.rows.length * columns
          }
          if (cells > 2_000) throw new Error("PDF tables are limited to 2,000 cells per document.")
          const characters = values.reduce((sum, value) => sum + value.length, 0)
          if (characters > 100_000) throw new Error("This PDF exceeds the 100,000-character limit.")
          for (const value of values) encode(value)
          if (!params.title) encode(path.basename(params.filePath))
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
              format: "pdf",
              title: params.title,
              blocks: params.blocks.length,
              tables: tables.length,
              cells,
            },
          })
          const result = yield* Effect.try({
            try: () => pdf(params),
            catch: (cause) => new Error(`Raya couldn't create this PDF: ${String(cause)}`),
          })
          const tmp = `${filepath}.raya-${randomUUID()}.tmp`
          const save = Effect.gen(function* () {
            if (!(yield* enabled)) {
              yield* fs.writeWithDirs(tmp, result.bytes)
              yield* fs.rename(tmp, filepath)
              return
            }
            yield* batchMutations(
              Effect.gen(function* () {
                yield* ensureDirectory(fs, path.dirname(filepath))
                yield* fs.writeFile(tmp, result.bytes)
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
            output: `Created ${path.basename(filepath)} with ${result.pages === 1 ? "1 page" : `${result.pages} pages`}.`,
            metadata: {
              filepath,
              exists,
              blocks: params.blocks.length,
              tables: tables.length,
              cells,
              pages: result.pages,
              characters,
              rayaRevision: revision,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
