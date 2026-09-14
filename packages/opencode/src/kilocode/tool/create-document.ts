import path from "node:path"
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Effect, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { assertMutablePath } from "@/kilocode/agent-manager/protection"
import * as Artifact from "@/kilocode/goal/artifact"
import { RayaPath } from "@/kilocode/task/path-boundary"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import * as Tool from "@/tool/tool"
import { parseImage, type OfficeImage } from "./office-image"
import * as Output from "./reviewed-output"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000))
const Cell = Schema.String.check(Schema.isMaxLength(5_000))
const Image = Schema.Struct({
  type: Schema.Literal("image"),
  filePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  alt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  caption: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  width: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(6.5)),
  ).annotate({ description: "Optional display width in inches, from 1 to 6.5." }),
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
    rows: Schema.Array(Schema.Array(Cell).check(Schema.isMinLength(1), Schema.isMaxLength(20))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
    header: Schema.optional(Schema.Boolean),
  }),
  Image,
])
const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Destination path ending in .docx." }),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
  author: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  blocks: Schema.Array(Block).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
})

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function text(value: string) {
  return value
    .split(/\r?\n/)
    .map((line, index) => `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${escape(line)}</w:t>`)
    .join("")
}

function paragraph(value: string, style?: string, list?: number) {
  const format = `${style ? `<w:pStyle w:val="${style}"/>` : ""}${
    list === undefined ? "" : `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${list}"/></w:numPr>`
  }`
  return `<w:p>${format ? `<w:pPr>${format}</w:pPr>` : ""}<w:r>${text(value)}</w:r></w:p>`
}

function table(rows: readonly (readonly string[])[], header = true) {
  const width = Math.floor(10_080 / rows[0]!.length)
  const grid = rows[0]!.map(() => `<w:gridCol w:w="${width}"/>`).join("")
  const body = rows
    .map((row, index) => {
      const head = header && index === 0
      const cells = row
        .map(
          (cell) =>
            `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EBF0"/>' : ""}</w:tcPr>${paragraph(cell, head ? "TableHeader" : undefined)}</w:tc>`,
        )
        .join("")
      return `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`
    })
    .join("")
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B9C0CC"/><w:left w:val="single" w:sz="4" w:color="B9C0CC"/><w:bottom w:val="single" w:sz="4" w:color="B9C0CC"/><w:right w:val="single" w:sz="4" w:color="B9C0CC"/><w:insideH w:val="single" w:sz="4" w:color="D7DBE2"/><w:insideV w:val="single" w:sz="4" w:color="D7DBE2"/></w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
}

type Loaded = OfficeImage & {
  readonly index: number
  readonly bytes: Uint8Array
  readonly name: string
  readonly alt: string
  readonly caption?: string
  readonly display?: number
}

function picture(image: Loaded, relationship: number, id: number) {
  const requested = image.display ?? Math.min(6.5, Math.max(1, image.width / 96))
  const height = (requested * image.height) / image.width
  const scale = Math.min(1, 8 / height)
  const cx = Math.round(requested * scale * 914_400)
  const cy = Math.round(height * scale * 914_400)
  const name = escape(image.name)
  const alt = escape(image.alt.trim())
  const drawing = `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="${name}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${name}" descr="${alt}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  return `${drawing}${image.caption ? paragraph(image.caption.trim(), "Caption") : ""}`
}

async function document(input: typeof Parameters.Type, images: readonly Loaded[]) {
  const loaded = new Map(images.map((image) => [image.index, image]))
  const body = [
    ...(input.title ? [paragraph(input.title.trim(), "Title")] : []),
    ...input.blocks.flatMap((block, index) => {
      if (block.type === "heading") return [paragraph(block.text.trim(), `Heading${block.level}`)]
      if (block.type === "paragraph") return [paragraph(block.text)]
      if (block.type === "table") return [table(block.rows, block.header)]
      if (block.type === "image") {
        const image = loaded.get(index)
        if (!image) throw new Error(`Document image ${index + 1} was not loaded.`)
        return [picture(image, images.indexOf(image) + 3, images.indexOf(image) + 1)]
      }
      return block.items.map((item) => paragraph(item, undefined, block.type === "bullets" ? 1 : 2))
    }),
  ].join("")
  const created = new Date().toISOString()
  const writer = new ZipWriter(new Uint8ArrayWriter())
  const media = images
    .map(
      (image, index) =>
        `<Relationship Id="rId${index + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.${image.extension}"/>`,
    )
    .join("")
  const files: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escape(input.title?.trim() ?? "")}</dc:title><dc:creator>${escape(input.author?.trim() ?? "Raya")}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${media}</Relationships>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Outfit" w:hAnsi="Outfit"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:rFonts w:ascii="Instrument Serif" w:hAnsi="Instrument Serif"/><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table header"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="596273"/><w:sz w:val="19"/></w:rPr></w:style>${[1, 2, 3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 320 : 240}" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Instrument Serif" w:hAnsi="Instrument Serif"/><w:b/><w:sz w:val="${level === 1 ? 32 : level === 2 ? 28 : 24}"/></w:rPr></w:style>`).join("")}</w:styles>`,
    "word/numbering.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  }
  for (const [index, image] of images.entries()) files[`word/media/image${index + 1}.${image.extension}`] = image.bytes
  for (const [name, value] of Object.entries(files))
    await writer.add(name, typeof value === "string" ? new TextReader(value) : new Uint8ArrayReader(value))
  return writer.close()
}

export const CreateDocumentTool = Tool.define(
  "create_document",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Create a real Word .docx document from a title and structured headings, paragraphs, lists, tables or local PNG/JPEG images. Images require alt text, read permission, valid headers and dimensions, and are limited to 20 files, 10 MiB each and 40 MiB combined. Tables accept 1 to 100 rectangular rows with 1 to 20 columns; the first row is styled as a repeating header unless header is false. Returns a verified local artifact receipt. It does not fetch network images, import templates, track changes, preserve an existing document or guarantee identical pagination across Word processors.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          if (path.extname(filepath).toLowerCase() !== ".docx") throw new Error("Choose a destination ending in .docx.")
          const tables = params.blocks.filter((block) => block.type === "table")
          const sources = params.blocks.flatMap((block, index) => (block.type === "image" ? [{ block, index }] : []))
          if (sources.length > 20) throw new Error("A document can contain at most 20 images.")
          for (const block of tables) {
            const columns = block.rows[0]!.length
            if (block.rows.some((row) => row.length !== columns))
              throw new Error("Every row in a document table must have the same number of columns.")
          }
          const cells = tables.reduce((sum, block) => sum + block.rows.length * block.rows[0]!.length, 0)
          if (cells > 2_000) throw new Error("This document exceeds the 2,000-table-cell limit.")
          if (tables.some((block) => block.rows.flat().every((value) => !value.trim())))
            throw new Error("Each document table needs at least one non-blank cell.")
          const values = [
            params.title,
            params.author,
            ...params.blocks.flatMap((block) => {
              if (block.type === "table") return []
              if (block.type === "image") return [block.alt, block.caption]
              if ("items" in block) return block.items
              return [block.text]
            }),
          ].filter((value): value is string => value !== undefined)
          if (values.some((value) => !value.trim())) throw new Error("Document text can't be blank.")
          const characters = [...values, ...tables.flatMap((block) => block.rows.flat())].reduce(
            (sum, value) => sum + value.length,
            0,
          )
          if (characters > 200_000) throw new Error("This document exceeds the 200,000-character limit.")
          const files: { source: (typeof sources)[number]; requested: string; target: string; ext: string }[] = []
          for (const source of sources) {
            const requested = path.isAbsolute(source.block.filePath)
              ? source.block.filePath
              : path.resolve(instance.directory, source.block.filePath)
            const ext = path.extname(requested).toLowerCase()
            if (![".png", ".jpg", ".jpeg"].includes(ext))
              throw new Error("Document images must end in .png, .jpg or .jpeg.")
            const info = yield* fs.stat(requested)
            if (info.type !== "File") throw new Error(`Document image is not a file: ${path.basename(requested)}`)
            if (info.size > 10 * 1024 * 1024) throw new Error("Each document image must be 10 MiB or smaller.")
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
              metadata: { files: files.map((file) => file.target), format: "image", purpose: "document" },
            })
          const images: Loaded[] = []
          for (const file of files) {
            const source = file.source
            const requested = file.requested
            const target = file.target
            const ext = file.ext
            const current = yield* fs.realPath(requested)
            const canonical = process.platform === "win32" ? FSUtil.normalizePath(current) : current
            if (canonical !== target) throw new Error("The document image changed after read approval. Try again.")
            const bytes = yield* fs.readFile(target)
            if (bytes.length > 10 * 1024 * 1024) throw new Error("Each document image must be 10 MiB or smaller.")
            if (images.reduce((sum, image) => sum + image.bytes.length, 0) + bytes.length > 40 * 1024 * 1024)
              throw new Error("Document images exceed the 40 MiB combined limit.")
            const image = yield* Effect.try({
              try: () => parseImage(bytes, ext),
              catch: (cause) => new Error(`Raya couldn't read ${path.basename(requested)}: ${String(cause)}`),
            })
            images.push({
              ...image,
              index: source.index,
              bytes,
              name: path.basename(requested),
              alt: source.block.alt,
              caption: source.block.caption,
              display: source.block.width,
            })
          }
          assertMutablePath(filepath)
          const target = yield* RayaPath.canonical(fs, filepath)
          assertMutablePath(target)
          yield* assertExternalDirectoryEffect(ctx, target)
          const review = yield* Output.review(fs, target)
          const exists = review.exists
          yield* ctx.ask({
            permission: "edit",
            patterns: RayaPath.patterns(instance.worktree, [filepath, target]),
            always: ["*"],
            metadata: {
              filepath,
              exists,
              format: "docx",
              title: params.title,
              blocks: params.blocks.length,
              cells,
              images: images.length,
            },
          })
          const bytes = yield* Effect.tryPromise({
            try: () => document(params, images),
            catch: (cause) => new Error(`Raya couldn't create this document: ${String(cause)}`),
          })
          yield* RayaPath.check(fs, filepath, target)
          yield* Output.commit(target, bytes, review)
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: exists ? "change" : "add" })
          const revision = yield* Artifact.capture(fs, target)
          return {
            title: path.relative(instance.worktree, filepath),
            output: `Created ${path.basename(filepath)} with ${params.blocks.length === 1 ? "1 block" : `${params.blocks.length} blocks`}.`,
            metadata: {
              filepath,
              exists,
              blocks: params.blocks.length,
              cells,
              images: images.length,
              characters,
              rayaRevision: revision,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
