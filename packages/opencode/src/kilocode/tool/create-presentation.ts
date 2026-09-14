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

const Copy = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(5_000))
const Cell = Schema.String.check(Schema.isMaxLength(1_000))
const Table = Schema.Struct({
  rows: Schema.Array(Schema.Array(Cell).check(Schema.isMinLength(1), Schema.isMaxLength(6))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12),
  ),
  header: Schema.optional(Schema.Boolean),
})
const Image = Schema.Struct({
  filePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  alt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  caption: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  width: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10.5)),
  ).annotate({ description: "Optional display width in inches, from 1 to 10.5." }),
})
const Slide = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  subtitle: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  body: Schema.optional(Copy),
  points: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(12),
    ),
  ),
  ordered: Schema.optional(Schema.Boolean),
  table: Schema.optional(Table),
  image: Schema.optional(Image),
})
const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Destination path ending in .pptx." }),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  author: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  accent: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9A-Fa-f]{6}$/)).annotate({
      description: "Optional six-digit RGB accent without #. Defaults to Raya's 45557A.",
    }),
  ),
  slides: Schema.Array(Slide).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
})

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function group() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
}

function para(value: string, opts: { size: number; color: string; face: string; bold?: boolean; list?: string }) {
  const list = opts.list
    ? `<a:pPr marL="342900" indent="-171450">${opts.list === "ordered" ? '<a:buAutoNum type="arabicPeriod"/>' : '<a:buChar char="•"/>'}</a:pPr>`
    : "<a:pPr/>"
  return `<a:p>${list}<a:r><a:rPr lang="en-US" sz="${opts.size}"${opts.bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${opts.color}"/></a:solidFill><a:latin typeface="${opts.face}"/></a:rPr><a:t>${escape(value)}</a:t></a:r><a:endParaRPr lang="en-US" sz="${opts.size}"/></a:p>`
}

function textbox(input: {
  id: number
  name: string
  x: number
  y: number
  cx: number
  cy: number
  paragraphs: string
  margin?: number
}) {
  const margin = input.margin ?? 0
  return `<p:sp><p:nvSpPr><p:cNvPr id="${input.id}" name="${input.name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${input.x}" y="${input.y}"/><a:ext cx="${input.cx}" cy="${input.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${margin}" tIns="${margin}" rIns="${margin}" bIns="${margin}" anchor="t"/><a:lstStyle/>${input.paragraphs}</p:txBody></p:sp>`
}

function line(accent: string) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Accent line"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="731520" y="1371600"/><a:ext cx="10972800" cy="45720"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
}

function table(input: typeof Table.Type, y: number) {
  const rows = input.rows
  const header = input.header ?? true
  const width = Math.floor(10_972_800 / rows[0]!.length)
  const height = Math.floor(3_657_600 / rows.length)
  const grid = rows[0]!.map(() => `<a:gridCol w="${width}"/>`).join("")
  const body = rows
    .map((row, index) => {
      const head = header && index === 0
      const cells = row
        .map((value) => {
          const copy = para(value, { size: 1400, color: "252A34", face: "Outfit", bold: head })
          const fill = head
            ? '<a:solidFill><a:srgbClr val="E8EBF0"/></a:solidFill>'
            : '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'
          const edge = '<a:solidFill><a:srgbClr val="B9C0CC"/></a:solidFill><a:prstDash val="solid"/>'
          return `<a:tc><a:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${copy}</a:txBody><a:tcPr marL="91440" marR="91440" marT="68580" marB="68580"><a:lnL w="6350">${edge}</a:lnL><a:lnR w="6350">${edge}</a:lnR><a:lnT w="6350">${edge}</a:lnT><a:lnB w="6350">${edge}</a:lnB>${fill}</a:tcPr></a:tc>`
        })
        .join("")
      return `<a:tr h="${height}">${cells}</a:tr>`
    })
    .join("")
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="731520" y="${y}"/><a:ext cx="10972800" cy="3657600"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${header ? 1 : 0}" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

type Loaded = OfficeImage & {
  readonly slide: number
  readonly bytes: Uint8Array
  readonly name: string
  readonly alt: string
  readonly caption?: string
  readonly display?: number
}

function picture(image: Loaded, y: number) {
  const requested = image.display ?? Math.min(10.5, Math.max(1, image.width / 96))
  const natural = (requested * image.height) / image.width
  const height = image.caption ? 3.25 : 3.75
  const scale = Math.min(1, height / natural)
  const cx = Math.round(requested * scale * 914_400)
  const cy = Math.round(natural * scale * 914_400)
  const x = Math.round((12_192_000 - cx) / 2)
  const name = escape(image.name)
  const alt = escape(image.alt.trim())
  const imageXml = `<p:pic><p:nvPicPr><p:cNvPr id="5" name="${name}" descr="${alt}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></p:spPr></p:pic>`
  if (!image.caption) return imageXml
  const caption = textbox({
    id: 7,
    name: "Image caption",
    x: 1_371_600,
    y: y + cy + 137_160,
    cx: 9_448_800,
    cy: 411_480,
    paragraphs: para(image.caption.trim(), { size: 1200, color: "596273", face: "Outfit" }),
  })
  return imageXml + caption
}

function slide(input: typeof Slide.Type, index: number, accent: string, image?: Loaded) {
  const title = textbox({
    id: 2,
    name: "Title",
    x: 731520,
    y: 411480,
    cx: 10972800,
    cy: 822960,
    paragraphs: para(input.title.trim(), { size: 3000, color: "171A21", face: "Instrument Serif", bold: true }),
  })
  const subtitle = input.subtitle
    ? textbox({
        id: 4,
        name: "Subtitle",
        x: 731520,
        y: 1645920,
        cx: 10972800,
        cy: 548640,
        paragraphs: para(input.subtitle.trim(), { size: 1600, color: "596273", face: "Outfit" }),
      })
    : ""
  const copy = [
    ...(input.body
      ?.split(/\r?\n/)
      .filter((value) => value.trim())
      .map((value) => para(value, { size: 1800, color: "252A34", face: "Outfit" })) ?? []),
    ...(input.points?.map((value) =>
      para(value.trim(), { size: 1800, color: "252A34", face: "Outfit", list: input.ordered ? "ordered" : "bullets" }),
    ) ?? []),
  ].join("")
  const body = copy
    ? textbox({
        id: 5,
        name: "Content",
        x: 731520,
        y: input.subtitle ? 2286000 : 1737360,
        cx: 10972800,
        cy: 3657600,
        paragraphs: copy,
      })
    : ""
  const grid = input.table ? table(input.table, input.subtitle ? 2286000 : 1737360) : ""
  const visual = image ? picture(image, input.subtitle ? 2286000 : 1737360) : ""
  const number = textbox({
    id: 6,
    name: "Slide number",
    x: 11277600,
    y: 6309360,
    cx: 548640,
    cy: 274320,
    paragraphs: para(String(index), { size: 900, color: "737C8C", face: "Outfit" }),
  })
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group()}${title}${line(accent)}${subtitle}${body}${grid}${visual}${number}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

async function presentation(input: typeof Parameters.Type, images: readonly Loaded[]) {
  const accent = (input.accent ?? "45557A").toUpperCase()
  const writer = new ZipWriter(new Uint8ArrayWriter())
  const overrides = input.slides
    .map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("")
  const ids = input.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")
  const rels = input.slides
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
    )
    .join("")
  const types = `${images.some((image) => image.extension === "png") ? '<Default Extension="png" ContentType="image/png"/>' : ""}${images.some((image) => image.extension === "jpg") ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : ""}`
  const files: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides}</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escape(input.title?.trim() ?? input.slides[0]!.title.trim())}</dc:title><dc:creator>${escape(input.author?.trim() ?? "Raya")}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Raya</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${input.slides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop></Properties>`,
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${rels}</Relationships>`,
    "ppt/slideMasters/slideMaster1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Raya"><p:spTree>${group()}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
    "ppt/slideLayouts/slideLayout1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group()}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    "ppt/theme/theme1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Raya"><a:themeElements><a:clrScheme name="Raya"><a:dk1><a:srgbClr val="171A21"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="252A34"/></a:dk2><a:lt2><a:srgbClr val="F3F5F8"/></a:lt2><a:accent1><a:srgbClr val="${accent}"/></a:accent1><a:accent2><a:srgbClr val="6D7890"/></a:accent2><a:accent3><a:srgbClr val="8A93A3"/></a:accent3><a:accent4><a:srgbClr val="A7AEB9"/></a:accent4><a:accent5><a:srgbClr val="C4C9D1"/></a:accent5><a:accent6><a:srgbClr val="E1E4E9"/></a:accent6><a:hlink><a:srgbClr val="45557A"/></a:hlink><a:folHlink><a:srgbClr val="596273"/></a:folHlink></a:clrScheme><a:fontScheme name="Raya"><a:majorFont><a:latin typeface="Instrument Serif"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Outfit"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Raya"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:solidFill><a:schemeClr val="lt2"/></a:solidFill><a:solidFill><a:schemeClr val="dk1"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  }
  for (const [index, value] of input.slides.entries()) {
    const image = images.find((item) => item.slide === index)
    files[`ppt/slides/slide${index + 1}.xml`] = slide(value, index + 1, accent, image)
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${image ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${images.indexOf(image) + 1}.${image.extension}"/>` : ""}</Relationships>`
  }
  for (const [index, image] of images.entries()) files[`ppt/media/image${index + 1}.${image.extension}`] = image.bytes
  for (const [name, value] of Object.entries(files))
    await writer.add(name, typeof value === "string" ? new TextReader(value) : new Uint8ArrayReader(value))
  return writer.close()
}

export const CreatePresentationTool = Tool.define(
  "create_presentation",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Create a real widescreen PowerPoint .pptx deck from structured slide titles, subtitles, body text, lists, tables or local PNG/JPEG images. Images require alt text and read permission, are limited to 20 files, 10 MiB each and 40 MiB combined, and cannot share a slide with body text, list points or a table. Tables accept 1 to 12 rectangular rows with 1 to 6 columns. Uses Raya's restrained accent and typography by default and returns a verified local artifact receipt. It does not fetch network images, import templates, add charts, notes or animation, embed fonts or guarantee identical layout across presentation apps.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          if (path.extname(filepath).toLowerCase() !== ".pptx") throw new Error("Choose a destination ending in .pptx.")
          const tables = params.slides.flatMap((slide) => (slide.table ? [slide.table] : []))
          const sources = params.slides.flatMap((slide, index) => (slide.image ? [{ image: slide.image, index }] : []))
          if (sources.length > 20) throw new Error("A presentation can contain at most 20 images.")
          for (const slide of params.slides) {
            if (slide.table && (slide.body || slide.points))
              throw new Error("A presentation table can't share a slide with body text or list points.")
            if (slide.image && (slide.body || slide.points || slide.table))
              throw new Error("A presentation image can't share a slide with body text, list points or a table.")
            if (!slide.table) continue
            const columns = slide.table.rows[0]!.length
            if (slide.table.rows.some((row) => row.length !== columns))
              throw new Error("Every row in a presentation table must have the same number of columns.")
            if (slide.table.rows.flat().every((value) => !value.trim()))
              throw new Error("Each presentation table needs at least one non-blank cell.")
          }
          const cells = tables.reduce((sum, table) => sum + table.rows.length * table.rows[0]!.length, 0)
          if (cells > 300) throw new Error("This presentation exceeds the 300-table-cell limit.")
          const values = [
            params.title,
            params.author,
            ...params.slides.flatMap((slide) => [
              slide.title,
              slide.subtitle,
              slide.body,
              ...(slide.points ?? []),
              ...(slide.table?.rows.flat() ?? []),
              slide.image?.alt,
              slide.image?.caption,
            ]),
          ].filter((value): value is string => value !== undefined)
          const copy = params.slides.flatMap((slide) => [
            slide.title,
            slide.subtitle,
            slide.body,
            ...(slide.points ?? []),
            slide.image?.alt,
            slide.image?.caption,
          ])
          if ([params.title, params.author, ...copy].some((value) => value !== undefined && !value.trim()))
            throw new Error("Presentation text can't be blank.")
          const characters = values.reduce((sum, value) => sum + value.length, 0)
          if (characters > 100_000) throw new Error("This presentation exceeds the 100,000-character limit.")
          const files: { source: (typeof sources)[number]; requested: string; target: string; ext: string }[] = []
          for (const source of sources) {
            const requested = path.isAbsolute(source.image.filePath)
              ? source.image.filePath
              : path.resolve(instance.directory, source.image.filePath)
            const ext = path.extname(requested).toLowerCase()
            if (![".png", ".jpg", ".jpeg"].includes(ext))
              throw new Error("Presentation images must end in .png, .jpg or .jpeg.")
            const info = yield* fs.stat(requested)
            if (info.type !== "File") throw new Error(`Presentation image is not a file: ${path.basename(requested)}`)
            if (info.size > 10 * 1024 * 1024) throw new Error("Each presentation image must be 10 MiB or smaller.")
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
              metadata: { files: files.map((file) => file.target), format: "image", purpose: "presentation" },
            })
          const images: Loaded[] = []
          for (const file of files) {
            const current = yield* fs.realPath(file.requested)
            const canonical = process.platform === "win32" ? FSUtil.normalizePath(current) : current
            if (canonical !== file.target)
              throw new Error("The presentation image changed after read approval. Try again.")
            const bytes = yield* fs.readFile(file.target)
            if (bytes.length > 10 * 1024 * 1024) throw new Error("Each presentation image must be 10 MiB or smaller.")
            if (images.reduce((sum, image) => sum + image.bytes.length, 0) + bytes.length > 40 * 1024 * 1024)
              throw new Error("Presentation images exceed the 40 MiB combined limit.")
            const image = yield* Effect.try({
              try: () => parseImage(bytes, file.ext),
              catch: (cause) => new Error(`Raya couldn't read ${path.basename(file.requested)}: ${String(cause)}`),
            })
            images.push({
              ...image,
              slide: file.source.index,
              bytes,
              name: path.basename(file.requested),
              alt: file.source.image.alt,
              caption: file.source.image.caption,
              display: file.source.image.width,
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
              format: "pptx",
              title: params.title,
              slides: params.slides.length,
              cells,
              images: images.length,
            },
          })
          const bytes = yield* Effect.tryPromise({
            try: () => presentation(params, images),
            catch: (cause) => new Error(`Raya couldn't create this presentation: ${String(cause)}`),
          })
          yield* RayaPath.check(fs, filepath, target)
          yield* Output.commit(target, bytes, review)
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: exists ? "change" : "add" })
          const revision = yield* Artifact.capture(fs, target)
          return {
            title: path.relative(instance.worktree, filepath),
            output: `Created ${path.basename(filepath)} with ${params.slides.length === 1 ? "1 slide" : `${params.slides.length} slides`}.`,
            metadata: {
              filepath,
              exists,
              slides: params.slides.length,
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
