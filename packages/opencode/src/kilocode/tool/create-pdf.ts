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
import { parseImage } from "./office-image"
import { parsePdfImage, type PdfImage } from "./pdf-image"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
const Cell = Schema.String.check(Schema.isMaxLength(300))
const Image = Schema.Struct({
  type: Schema.Literal("image"),
  filePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  alt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  caption: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  width: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(7)),
  ).annotate({ description: "Optional display width in inches, from 1 to 7." }),
})
const Link = Schema.Struct({
  type: Schema.Literal("link"),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
})
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
  Image,
  Link,
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

function utf8(value: string) {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
}

function address(value: string) {
  if (value !== value.trim() || !URL.canParse(value)) throw new Error("PDF links require a valid http or https URL.")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("PDF links require a credential-free http or https URL.")
  if (url.href.length > 2_048) throw new Error("A normalized PDF link exceeds 2,048 characters.")
  return url.href
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
  | { image: Loaded; before?: number; after?: number }
  | { link: { text: string; url: string }; before?: number; after?: number }

type Mark = { readonly x: number; readonly y: number; readonly width: number; readonly url: string }

type Loaded = PdfImage & {
  readonly index: number
  readonly alt: string
  readonly caption?: string
  readonly display?: number
}

function merge(parts: readonly Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function pdf(input: typeof Parameters.Type, images: readonly Loaded[]) {
  const loaded = new Map(images.map((image) => [image.index, image]))
  const rows: Row[] = []
  if (input.title) rows.push({ text: input.title.trim(), size: 28, font: "F1", after: 18 })
  for (const [index, block] of input.blocks.entries()) {
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
    if (block.type === "image") {
      const image = loaded.get(index)
      if (!image) throw new Error(`PDF image ${index + 1} was not loaded.`)
      rows.push({ image, before: 8, after: 9 })
      continue
    }
    if (block.type === "link") {
      rows.push({ link: { text: block.text, url: address(block.url) }, before: 3, after: 9 })
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
  const marks: Mark[][] = [[]]
  const accent = input.accent ?? "45557A"
  const rgb = [0, 2, 4].map((index) => (Number.parseInt(accent.slice(index, index + 2), 16) / 255).toFixed(3))
  let y = 720
  for (const [index, row] of rows.entries()) {
    y -= row.before ?? 0
    if ("image" in row) {
      const requested = (row.image.display ?? Math.min(7, Math.max(1, row.image.width / 96))) * 72
      const natural = (requested * row.image.height) / row.image.width
      const caption = row.image.caption ? wrap(row.image.caption.trim(), 10) : []
      const available = Math.max(72, 648 - caption.length * 13.5 - 4)
      const scale = Math.min(1, 504 / requested, available / natural)
      const width = requested * scale
      const height = natural * scale
      const total = height + caption.length * 13.5
      if (y - total < 72) {
        pages.push([])
        marks.push([])
        y = 720
      }
      const x = 54 + (504 - width) / 2
      const bottom = y - height
      pages
        .at(-1)!
        .push(
          `/Figure << /Alt <${encode(row.image.alt.trim())}> >> BDC q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${bottom.toFixed(2)} cm /Im${row.image.index + 1} Do Q EMC`,
        )
      y = bottom - 4
      for (const line of caption) {
        if (line) pages.at(-1)!.push(`BT /F2 10 Tf 0.349 0.384 0.451 rg 54 ${y.toFixed(2)} Td <${encode(line)}> Tj ET`)
        y -= 13.5
      }
      y -= row.after ?? 0
      continue
    }
    if ("link" in row) {
      const lines = wrap(row.link.text.trim(), 11)
      for (const line of lines) {
        const height = 14.85
        if (y - height < 72) {
          pages.push([])
          marks.push([])
          y = 720
        }
        if (line) {
          const width = Math.min(504, line.length * 11 * 0.52)
          pages
            .at(-1)!
            .push(
              `BT /F2 11 Tf ${rgb.join(" ")} rg 54 ${y.toFixed(2)} Td <${encode(line)}> Tj ET ${rgb.join(" ")} rg 54 ${(y - 2).toFixed(2)} ${width.toFixed(2)} 0.5 re f`,
            )
          marks.at(-1)!.push({ x: 54, y: y - 3, width, url: row.link.url })
        }
        y -= height
      }
      y -= row.after ?? 0
      continue
    }
    if ("cells" in row) {
      const width = 504 / row.cells.length
      const cells = row.cells.map((cell) => wrap(cell.trim(), 9, 0, width - 12))
      const height = Math.max(1, ...cells.map((lines) => lines.length)) * 12.15 + 10
      if (y - height < 72) {
        pages.push([])
        marks.push([])
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
        marks.push([])
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

  const encoder = new TextEncoder()
  const objects: (string | Uint8Array)[] = [
    "",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  const info = objects.push(
    `<< /Title <${encode(input.title?.trim() ?? path.basename(input.filePath))}> /Author <${encode(input.author?.trim() ?? "Raya")}> /Producer <${encode("Raya")}> >>`,
  )
  const refs = new Map<number, number>()
  for (const image of images) {
    const mask = image.alpha
      ? objects.push(
          merge([
            encoder.encode(
              `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alpha.length} >>\nstream\n`,
            ),
            image.alpha,
            encoder.encode("\nendstream"),
          ]),
        )
      : undefined
    const dict = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.color} /BitsPerComponent 8 /Filter /${image.filter} /Length ${image.bytes.length}${mask ? ` /SMask ${mask} 0 R` : ""} >>\nstream\n`
    const id = objects.push(merge([encoder.encode(dict), image.bytes, encoder.encode("\nendstream")]))
    refs.set(image.index, id)
  }
  const xobjects = images.length
    ? ` /XObject << ${images.map((image) => `/Im${image.index + 1} ${refs.get(image.index)} 0 R`).join(" ")} >>`
    : ""
  const kids: number[] = []
  for (const [index, page] of pages.entries()) {
    const stream = page.join("\n")
    const content = objects.push(
      `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
    )
    const annotations = marks[index]!.map((mark) =>
      objects.push(
        `<< /Type /Annot /Subtype /Link /Rect [${mark.x.toFixed(2)} ${mark.y.toFixed(2)} ${(mark.x + mark.width).toFixed(2)} ${(mark.y + 15).toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI <${utf8(mark.url)}> >> >>`,
      ),
    )
    const annots = annotations.length ? ` /Annots [${annotations.map((id) => `${id} 0 R`).join(" ")}]` : ""
    const id = objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${content} 0 R${annots} >>`,
    )
    kids.push(id)
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>"
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] >>`

  const parts: Uint8Array[] = [encoder.encode("%PDF-1.7\n%Raya\n")]
  const offsets = [0]
  let length = parts[0]!.length
  for (const [index, object] of objects.entries()) {
    offsets.push(length)
    const bytes = merge([
      encoder.encode(`${index + 1} 0 obj\n`),
      typeof object === "string" ? encoder.encode(object) : object,
      encoder.encode("\nendobj\n"),
    ])
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
  return { bytes: merge(parts), pages: pages.length }
}

export const CreatePdfTool = Tool.define(
  "create_pdf",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Create a real paginated PDF from a title and structured headings, paragraphs, lists, rectangular tables, local PNG/JPEG images or credential-free http/https links. Images require alt text, read permission, valid headers and dimensions; PNG files must use 8-bit channels without interlacing. Images are limited to 10 files, 8 MiB each, 24 MiB combined and 20 megapixels combined. Tables support up to 8 columns and 100 rows each, with an optional first-row header. Links become visible text with native PDF annotations. The writer supports printable WinAnsi text, creates at most 200 pages and returns a verified local artifact receipt. It creates a new PDF or replaces the whole destination after approval. It does not fetch network images, open links while creating the file, import or edit an existing PDF, embed custom fonts, create forms, produce a fully tagged accessible PDF, or guarantee archival conformance.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          if (path.extname(filepath).toLowerCase() !== ".pdf") throw new Error("Choose a destination ending in .pdf.")
          const text = params.blocks.flatMap((block) =>
            block.type === "table"
              ? block.rows.flat()
              : block.type === "image"
                ? [block.alt, block.caption].filter((value): value is string => value !== undefined)
                : "items" in block
                  ? block.items
                  : [block.text],
          )
          const values = [params.title, params.author, ...text].filter((value): value is string => value !== undefined)
          const required = [
            params.title,
            params.author,
            ...params.blocks.flatMap((block) =>
              block.type === "table"
                ? []
                : block.type === "image"
                  ? [block.alt, block.caption].filter((value): value is string => value !== undefined)
                  : "items" in block
                    ? block.items
                    : [block.text],
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
          const sources = params.blocks.flatMap((block, index) => (block.type === "image" ? [{ block, index }] : []))
          const links = params.blocks.filter((block) => block.type === "link")
          for (const link of links) address(link.url)
          if (sources.length > 10) throw new Error("A PDF can contain at most 10 images.")
          const characters = [...values, ...links.map((link) => link.url)].reduce((sum, value) => sum + value.length, 0)
          if (characters > 100_000) throw new Error("This PDF exceeds the 100,000-character limit.")
          for (const value of values) encode(value)
          if (!params.title) encode(path.basename(params.filePath))
          const files: { source: (typeof sources)[number]; requested: string; target: string; ext: string }[] = []
          for (const source of sources) {
            const requested = path.isAbsolute(source.block.filePath)
              ? source.block.filePath
              : path.resolve(instance.directory, source.block.filePath)
            const ext = path.extname(requested).toLowerCase()
            if (![".png", ".jpg", ".jpeg"].includes(ext)) throw new Error("PDF images must end in .png, .jpg or .jpeg.")
            const info = yield* fs.stat(requested)
            if (info.type !== "File") throw new Error(`PDF image is not a file: ${path.basename(requested)}`)
            if (info.size > 8 * 1024 * 1024) throw new Error("Each PDF image must be 8 MiB or smaller.")
            const resolved = yield* fs.realPath(requested)
            const target = process.platform === "win32" ? FSUtil.normalizePath(resolved) : resolved
            yield* assertExternalDirectoryEffect(ctx, target)
            files.push({ source, requested, target, ext })
          }
          if (files.length)
            yield* ctx.ask({
              permission: "read",
              patterns: [
                ...new Set(
                  files.flatMap((file) =>
                    [file.requested, file.target].map((item) => path.relative(instance.worktree, item)),
                  ),
                ),
              ],
              always: ["*"],
              metadata: { files: files.map((file) => file.target), format: "image", purpose: "pdf" },
            })
          const images: Loaded[] = []
          let bytes = 0
          let pixels = 0
          for (const file of files) {
            const current = yield* fs.realPath(file.requested)
            const canonical = process.platform === "win32" ? FSUtil.normalizePath(current) : current
            if (canonical !== file.target) throw new Error("The PDF image changed after read approval. Try again.")
            const data = yield* fs.readFile(file.target)
            if (data.length > 8 * 1024 * 1024) throw new Error("Each PDF image must be 8 MiB or smaller.")
            bytes += data.length
            if (bytes > 24 * 1024 * 1024) throw new Error("PDF images exceed the 24 MiB combined limit.")
            const dimensions = yield* Effect.try({
              try: () => parseImage(data, file.ext),
              catch: (cause) => new Error(`Raya couldn't read ${path.basename(file.requested)}: ${String(cause)}`),
            })
            pixels += dimensions.width * dimensions.height
            if (pixels > 20_000_000) throw new Error("PDF images exceed the 20-megapixel combined limit.")
            const image = yield* Effect.try({
              try: () => parsePdfImage(data, file.ext),
              catch: (cause) => new Error(`Raya couldn't read ${path.basename(file.requested)}: ${String(cause)}`),
            })
            images.push({
              ...image,
              index: file.source.index,
              alt: file.source.block.alt,
              caption: file.source.block.caption,
              display: file.source.block.width,
            })
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
              format: "pdf",
              title: params.title,
              blocks: params.blocks.length,
              tables: tables.length,
              cells,
              images: images.length,
              links: links.length,
            },
          })
          const result = yield* Effect.try({
            try: () => pdf(params, images),
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
              images: images.length,
              imageBytes: bytes,
              imagePixels: pixels,
              links: links.length,
              pages: result.pages,
              characters,
              rayaRevision: revision,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
