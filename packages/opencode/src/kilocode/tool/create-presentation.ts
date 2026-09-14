import { randomUUID } from "node:crypto"
import path from "node:path"
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
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

const Copy = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(5_000))
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

function slide(input: typeof Slide.Type, index: number, accent: string) {
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
  const number = textbox({
    id: 6,
    name: "Slide number",
    x: 11277600,
    y: 6309360,
    cx: 548640,
    cy: 274320,
    paragraphs: para(String(index), { size: 900, color: "737C8C", face: "Outfit" }),
  })
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group()}${title}${line(accent)}${subtitle}${body}${number}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

async function presentation(input: typeof Parameters.Type) {
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
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides}</Types>`,
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
    files[`ppt/slides/slide${index + 1}.xml`] = slide(value, index + 1, accent)
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
  }
  for (const [name, value] of Object.entries(files)) await writer.add(name, new TextReader(value))
  return writer.close()
}

export const CreatePresentationTool = Tool.define(
  "create_presentation",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    return {
      description:
        "Create a real widescreen PowerPoint .pptx deck from structured slide titles, subtitles, body text and bullet or numbered points. Uses Raya's restrained accent and typography by default and returns a verified local artifact receipt. It does not import templates, add images, charts, tables, notes or animation, embed fonts or guarantee identical pagination across presentation apps.",
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          if (path.extname(filepath).toLowerCase() !== ".pptx") throw new Error("Choose a destination ending in .pptx.")
          const values = [
            params.title,
            params.author,
            ...params.slides.flatMap((slide) => [slide.title, slide.subtitle, slide.body, ...(slide.points ?? [])]),
          ].filter((value): value is string => value !== undefined)
          if (values.some((value) => !value.trim())) throw new Error("Presentation text can't be blank.")
          const characters = values.reduce((sum, value) => sum + value.length, 0)
          if (characters > 100_000) throw new Error("This presentation exceeds the 100,000-character limit.")
          assertMutablePath(filepath)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          const exists = yield* fs.existsSafe(filepath)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath, exists, format: "pptx", title: params.title, slides: params.slides.length },
          })
          const bytes = yield* Effect.tryPromise({
            try: () => presentation(params),
            catch: (cause) => new Error(`Raya couldn't create this presentation: ${String(cause)}`),
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
            output: `Created ${path.basename(filepath)} with ${params.slides.length === 1 ? "1 slide" : `${params.slides.length} slides`}.`,
            metadata: { filepath, exists, slides: params.slides.length, characters, rayaRevision: revision },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
