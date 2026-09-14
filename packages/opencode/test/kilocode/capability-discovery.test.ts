import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { jsonSchema, tool, type Tool as AITool } from "ai"
import { read as parseWorkbook, utils, write as workbook } from "xlsx"
import { TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { LLMRequestPrep } from "@/session/llm/request"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import type { Plugin } from "@/plugin"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ReadTool } from "@/tool/read"
import { WriteTool } from "@/tool/write"
import { Truncate } from "@/tool/truncate"
import { CapabilityCatalog } from "@/kilocode/capability/catalog"
import { DiscoverCapabilitiesTool } from "@/kilocode/tool/discover-capabilities"
import { CreateSpreadsheetTool } from "@/kilocode/tool/create-spreadsheet"
import { CreateDocumentTool } from "@/kilocode/tool/create-document"
import { CreatePresentationTool } from "@/kilocode/tool/create-presentation"
import { CreatePdfTool } from "@/kilocode/tool/create-pdf"
import { builtin } from "@/kilocode/sandbox/network"
import { RayaChief } from "@/kilocode/chief"
import { ProviderTest } from "../fake/provider"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        EventV2Bridge.node,
        Format.node,
        LSP.node,
        Instruction.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
        Truncate.node,
      ]),
      // Fix only the external provider boundary; discovery, filtering and artifact tools run unchanged.
      [
        [
          Provider.node,
          ProviderTest.fake({
            getModel: (providerID, id) => Effect.succeed(ProviderTest.model({ providerID, id })),
          }).layer,
        ],
      ],
    ),
    RuntimeFlags.layer({ client: "test" }),
  ),
)
const model = ProviderTest.model()
const agent: Agent.Info = { name: "build", mode: "primary", options: {}, permission: [] }
// No plugins installed in this request-boundary fixture. Production preparation and filtering run unchanged.
const plugin: Plugin.Interface = {
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, value) => Effect.succeed(value),
}

const context = (extra?: Tool.Context["extra"]): Tool.Context => ({
  sessionID: SessionID.make("ses_discovery"),
  messageID: MessageID.make("msg_discovery"),
  callID: "call_discovery",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  extra,
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const definitions = Effect.gen(function* () {
  return yield* Effect.all({
    read: ReadTool.pipe(Effect.flatMap(Tool.init)),
    write: WriteTool.pipe(Effect.flatMap(Tool.init)),
    discover: DiscoverCapabilitiesTool.pipe(Effect.flatMap(Tool.init)),
    spreadsheet: CreateSpreadsheetTool.pipe(Effect.flatMap(Tool.init)),
    document: CreateDocumentTool.pipe(Effect.flatMap(Tool.init)),
    presentation: CreatePresentationTool.pipe(Effect.flatMap(Tool.init)),
    pdf: CreatePdfTool.pipe(Effect.flatMap(Tool.init)),
  })
})

function bind(defs: Tool.Def[], restricted = false) {
  const tools: Record<string, AITool> = Object.fromEntries(
    defs.map((def) => [
      def.id,
      tool({
        description: def.description,
        inputSchema: jsonSchema(ToolJsonSchema.fromTool(def)),
      }),
    ]),
  )
  const scope = CapabilityCatalog.bind(tools, restricted)
  for (const def of defs) scope.record(builtin(def), tools[def.id])
  return { tools, scope, ctx: context({ capabilities: scope.inspect }) }
}

const prepare = (
  tools: Record<string, AITool>,
  permission: Permission.Ruleset = [],
  toggles?: Record<string, boolean>,
) =>
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return yield* LLMRequestPrep.prepare({
      user: {
        id: MessageID.make("msg_discovery-user"),
        sessionID: SessionID.make("ses_discovery"),
        role: "user",
        time: { created: 0 },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
        tools: toggles,
      },
      sessionID: "ses_discovery",
      model,
      agent,
      permission,
      system: [],
      messages: [{ role: "user", content: "Inspect available local work" }],
      tools,
      provider: { id: model.providerID, name: "Fixture provider", source: "config", env: [], options: {}, models: {} },
      auth: undefined,
      plugin,
      flags,
      isWorkflow: false,
    })
  })

it.instance("uses actual model-request permission and per-turn filtering without granting execution", () =>
  Effect.gen(function* () {
    const defs = yield* definitions
    const bound = bind([defs.read, defs.write, defs.discover], true)
    expect(CapabilityCatalog.inspect(bound.ctx, { query: "spreadsheet" }).bound).toBe(false)
    const prepared = yield* prepare(bound.tools, Permission.fromConfig({ edit: "deny" }), { read: false })
    expect(Object.keys(prepared.tools)).toEqual(["discover_capabilities"])
    const result = yield* defs.discover.execute({ limit: 10 }, bound.ctx)
    const data = CapabilityCatalog.inspect(bound.ctx, { limit: 10 })
    expect(JSON.parse(result.output)).toEqual(data)
    expect(data.bound).toBe(true)
    expect(data.network).toBe("restricted")
    expect(data.capabilities.every((entry) => entry.status === "not-exposed")).toBe(true)
    expect(data.notice).toContain("does not execute, authorize")
    const next = bind([defs.read, defs.write, defs.discover])
    yield* prepare(next.tools)
    expect(CapabilityCatalog.inspect(next.ctx, { query: "spreadsheet" }).capabilities[0]).toMatchObject({
      id: "spreadsheets.extract",
      status: "available",
      tools: ["read"],
      authority: "permission-dependent",
    })
    expect(CapabilityCatalog.inspect(bound.ctx, { query: "spreadsheet" }).capabilities[0].status).toBe("not-exposed")
  }),
)

it.instance("ignores overwritten builtin names, absent discovery and Auto's filtered tools", () =>
  Effect.gen(function* () {
    const defs = yield* definitions
    const bound = bind([defs.read, defs.discover])
    bound.tools.read = tool({ description: "Unrelated plugin named read", inputSchema: jsonSchema({ type: "object" }) })
    yield* prepare(bound.tools)
    expect(CapabilityCatalog.inspect(bound.ctx, { query: "spreadsheet" }).capabilities[0].status).toBe("not-exposed")
    const auto = bind([defs.read, defs.discover])
    yield* prepare(RayaChief.tools(auto.tools, undefined))
    expect(CapabilityCatalog.inspect(auto.ctx, {}).bound).toBe(false)
    const absent = bind([defs.read, defs.discover])
    yield* prepare(absent.tools, Permission.fromConfig({ discover_capabilities: "deny" }))
    expect(CapabilityCatalog.inspect(absent.ctx, {}).bound).toBe(false)
  }),
)

it.instance("bounds and validates discovery and keeps unsupported spreadsheet claims explicit", () =>
  Effect.gen(function* () {
    const defs = yield* definitions
    const bound = bind([defs.read, defs.discover])
    yield* prepare(bound.tools)
    const result = CapabilityCatalog.inspect(bound.ctx, { limit: 2 })
    expect(result.capabilities).toHaveLength(2)
    expect(result.truncated).toBe(true)
    const spreadsheet = CapabilityCatalog.inspect(bound.ctx, { query: "spreadsheet" }).capabilities[0]
    expect(spreadsheet.inputs).toEqual(["XLSX", "ODS"])
    expect(spreadsheet.limits.join(" ")).toContain("Does not recalculate formulas, edit or export a workbook")
    expect(CapabilityCatalog.inspect(bound.ctx, { query: "nonexistent-integration" }).capabilities).toEqual([])
    expect(CapabilityCatalog.inspect(context(), {}).network).toBe("unknown")
    expect(
      CapabilityCatalog.inspect(
        context({
          capabilities: () => {
            throw new Error("Untrusted reader")
          },
        }),
        {},
      ).bound,
    ).toBe(false)
    expect(CapabilityCatalog.inspect(bound.ctx, { query: "Excel" }).capabilities[0].id).toBe("spreadsheets.extract")
    for (const query of [{ limit: 0 }, { limit: 11 }, { query: "x".repeat(201) }]) {
      expect(Exit.isFailure(yield* defs.discover.execute(query, bound.ctx).pipe(Effect.exit))).toBe(true)
    }
  }),
)

it.instance(
  "discovers extraction, reads an actual XLSX and writes a verifiable Markdown artifact",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const defs = yield* definitions
      const bound = bind([defs.read, defs.write, defs.discover])
      yield* prepare(bound.tools)
      const file = path.join(instance.directory, "sales.xlsx")
      const target = path.join(instance.directory, "findings.md")
      const book = utils.book_new()
      utils.book_append_sheet(
        book,
        utils.aoa_to_sheet([
          ["Product", "Units"],
          ["North", 17],
          ["South", 23],
        ]),
        "Sales",
      )
      yield* Effect.promise(() => Bun.write(file, workbook(book, { type: "buffer", bookType: "xlsx" })))
      const discovery = yield* defs.discover.execute({ query: "spreadsheet" }, bound.ctx)
      expect(discovery.output).toContain('"status":"available"')
      const approvals: string[] = []
      const ctx = {
        ...bound.ctx,
        ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
          Effect.sync(() => {
            approvals.push(request.permission)
          }),
      }
      const read = yield* defs.read.execute({ filePath: file }, ctx)
      expect(read.output).toContain("North")
      expect(read.output).toContain("17")
      expect(read.output).toContain("South")
      expect(read.output).toContain("23")
      const content = `# Extracted sales data\n\nSource: sales.xlsx. Values are extracted; formulas were not recalculated.\n\n${read.output}\n`
      const written = yield* defs.write.execute({ filePath: target, content }, ctx)
      expect(written.output).toContain("Wrote file successfully")
      expect(yield* Effect.promise(() => Bun.file(target).text())).toContain("North")
      expect(approvals).toContain("read")
      expect(approvals).toContain("edit")
      expect(written.metadata.rayaRevision).toMatchObject({ status: "captured", path: target })
      const denied = path.join(instance.directory, "denied.md")
      const failure = yield* defs.write
        .execute(
          { filePath: denied, content: "must not write" },
          {
            ...ctx,
            ask: () => Effect.die(new Error("Denied by fixture approval boundary")),
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(failure)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(denied).exists())).toBe(false)
    }),
  60_000,
)

it.instance(
  "creates a readable structured DOCX with approval and a verified artifact receipt",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const defs = yield* definitions
      const bound = bind([defs.read, defs.document, defs.discover])
      yield* prepare(bound.tools)
      const target = path.join(instance.directory, "project-brief.docx")
      const image = path.join(instance.directory, "workflow.png")
      yield* Effect.promise(() =>
        Bun.write(
          image,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
            "base64",
          ),
        ),
      )
      const approvals: string[] = []
      const ctx = {
        ...bound.ctx,
        ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
          Effect.sync(() => {
            approvals.push(request.permission)
          }),
      }
      expect(CapabilityCatalog.inspect(bound.ctx, { query: "create Word document" }).capabilities[0]).toMatchObject({
        id: "documents.create",
        status: "available",
        tools: ["create_document"],
      })
      const created = yield* defs.document.execute(
        {
          filePath: target,
          title: "Project North Star",
          author: "Raya",
          blocks: [
            { type: "heading", level: 1, text: "Purpose" },
            { type: "paragraph", text: "Build a clear, durable product plan & preserve decisions." },
            { type: "heading", level: 2, text: "Priorities" },
            { type: "bullets", items: ["Ship the core workflow", "Measure the outcome"] },
            { type: "numbered", items: ["Review", "Approve"] },
            {
              type: "table",
              rows: [
                ["Owner", "Decision"],
                ["Design", "Approve the flow"],
                ["Engineering", "Verify the build"],
                ["Notes", ""],
              ],
            },
            {
              type: "image",
              filePath: image,
              alt: "Workflow status mark",
              caption: "The current workflow is ready for review.",
              width: 1.5,
            },
          ],
        },
        ctx,
      )
      expect(created.output).toBe("Created project-brief.docx with 7 blocks.")
      expect(created.metadata).toMatchObject({
        filepath: target,
        exists: false,
        blocks: 7,
        cells: 8,
        images: 1,
        rayaRevision: { version: 1, status: "captured", path: target },
      })
      const bytes = new Uint8Array(yield* Effect.promise(() => Bun.file(target).arrayBuffer()))
      const archive = new ZipReader(new Uint8ArrayReader(bytes))
      const entries = yield* Effect.promise(() => archive.getEntries())
      const entry = entries.find((item) => item.filename === "word/document.xml")
      const styles = entries.find((item) => item.filename === "word/styles.xml")
      const rels = entries.find((item) => item.filename === "word/_rels/document.xml.rels")
      expect(entry?.getData).toBeDefined()
      expect(styles?.getData).toBeDefined()
      expect(rels?.getData).toBeDefined()
      expect(entries.some((item) => item.filename === "word/media/image1.png")).toBe(true)
      const xml = yield* Effect.promise(() => entry!.getData!(new TextWriter()))
      const css = yield* Effect.promise(() => styles!.getData!(new TextWriter()))
      const links = yield* Effect.promise(() => rels!.getData!(new TextWriter()))
      yield* Effect.promise(() => archive.close())
      expect(xml).toContain("<w:tbl>")
      expect(xml).toContain("<w:tblHeader/>")
      expect(xml).toContain('w:fill="E8EBF0"')
      expect(xml).toContain("<w:drawing>")
      expect(xml).toContain('descr="Workflow status mark"')
      expect(xml).toContain('r:embed="rId3"')
      expect(css).toContain('w:ascii="Instrument Serif"')
      expect(css).toContain('w:ascii="Outfit"')
      expect(css).toContain('w:styleId="Caption"')
      expect(links).toContain('Target="media/image1.png"')
      const read = yield* defs.read.execute({ filePath: target }, ctx)
      for (const value of [
        "Project North Star",
        "Purpose",
        "Build a clear, durable product plan & preserve decisions.",
        "Ship the core workflow",
        "Measure the outcome",
        "Review",
        "Approve",
        "Owner",
        "Decision",
        "Design",
        "Approve the flow",
        "Engineering",
        "Verify the build",
        "The current workflow is ready for review.",
      ])
        expect(read.output).toContain(value)
      expect(approvals).toEqual(["read", "edit", "read"])

      const before = yield* Effect.promise(() => Bun.file(target).arrayBuffer())
      const denied = yield* defs.document
        .execute(
          { filePath: target, blocks: [{ type: "paragraph", text: "must not replace" }] },
          { ...ctx, ask: () => Effect.die(new Error("Denied by fixture approval boundary")) },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(target).arrayBuffer())).toEqual(before)
      const replaced = yield* defs.document.execute(
        { filePath: target, title: "Revised brief", blocks: [{ type: "paragraph", text: "Approved replacement" }] },
        ctx,
      )
      expect(replaced.metadata).toMatchObject({ filepath: target, exists: true, blocks: 1 })
      const reread = yield* defs.read.execute({ filePath: target }, ctx)
      expect(reread.output).toContain("Revised brief")
      expect(reread.output).toContain("Approved replacement")
      expect(reread.output).not.toContain("Project North Star")
      for (const input of [
        { filePath: path.join(instance.directory, "wrong.txt"), blocks: [{ type: "paragraph" as const, text: "No" }] },
        {
          filePath: path.join(instance.directory, "blank.docx"),
          blocks: [{ type: "paragraph" as const, text: "   " }],
        },
        {
          filePath: path.join(instance.directory, "ragged.docx"),
          blocks: [
            {
              type: "table" as const,
              rows: [["A", "B"], ["C"]],
            },
          ],
        },
      ]) {
        expect(Exit.isFailure(yield* defs.document.execute(input, ctx).pipe(Effect.exit))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(input.filePath).exists())).toBe(false)
      }
      const oversized = path.join(instance.directory, "oversized.docx")
      const rows = Array.from({ length: 100 }, () => Array.from({ length: 20 }, () => "Bounded"))
      expect(
        Exit.isFailure(
          yield* defs.document
            .execute(
              {
                filePath: oversized,
                blocks: [
                  { type: "table", rows },
                  { type: "table", rows: [["One cell over the total limit"]] },
                ],
              },
              ctx,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(oversized).exists())).toBe(false)
      const invalid = path.join(instance.directory, "invalid-image.docx")
      const corrupt = path.join(instance.directory, "corrupt.png")
      yield* Effect.promise(() => Bun.write(corrupt, "not a png"))
      expect(
        Exit.isFailure(
          yield* defs.document
            .execute(
              {
                filePath: invalid,
                blocks: [{ type: "image", filePath: corrupt, alt: "Corrupt image" }],
              },
              ctx,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(invalid).exists())).toBe(false)
    }),
  60_000,
)

it.instance(
  "creates a bounded paginated PDF with approval and a verified artifact receipt",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const defs = yield* definitions
      const bound = bind([defs.pdf, defs.discover])
      yield* prepare(bound.tools)
      const target = path.join(instance.directory, "review-pack.pdf")
      const image = path.join(instance.directory, "status.png")
      yield* Effect.promise(() =>
        Bun.write(
          image,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY3ANrWoAAAOMAZVXSuBOAAAAAElFTkSuQmCC",
            "base64",
          ),
        ),
      )
      const approvals: string[] = []
      const ctx = {
        ...bound.ctx,
        ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
          Effect.sync(() => {
            approvals.push(request.permission)
          }),
      }
      expect(CapabilityCatalog.inspect(bound.ctx, { query: "create PDF" }).capabilities[0]).toMatchObject({
        id: "documents.create-pdf",
        status: "available",
        tools: ["create_pdf"],
      })
      const created = yield* defs.pdf.execute(
        {
          filePath: target,
          title: "Quarterly review",
          author: "Raya",
          blocks: [
            { type: "heading", level: 1, text: "What changed" },
            { type: "paragraph", text: "Revenue increased 17% while operating costs remained within plan." },
            {
              type: "table",
              rows: [
                ["Metric", "Value"],
                ["Revenue", "+17%"],
                ["Risks", "2 open"],
              ],
            },
            {
              type: "image",
              filePath: image,
              alt: "Quarterly status marker",
              caption: "Current status",
              width: 1,
            },
            { type: "bullets", items: ["Customer retention improved", "Two risks need review"] },
            { type: "numbered", items: Array.from({ length: 90 }, (_, index) => `Follow-up action ${index + 1}`) },
          ],
        },
        ctx,
      )
      expect(created.output).toMatch(/^Created review-pack\.pdf with \d+ pages\.$/)
      expect(created.metadata).toMatchObject({
        filepath: target,
        exists: false,
        blocks: 6,
        tables: 1,
        cells: 6,
        images: 1,
        imagePixels: 1,
        rayaRevision: { version: 1, status: "captured", path: target },
      })
      expect(Number(created.metadata.imageBytes)).toBeGreaterThan(0)
      expect(Number(created.metadata.pages)).toBeGreaterThan(1)
      expect(approvals).toEqual(["read", "edit"])
      const bytes = new Uint8Array(yield* Effect.promise(() => Bun.file(target).arrayBuffer()))
      const source = new TextDecoder().decode(bytes)
      expect(source).toStartWith("%PDF-1.7")
      expect(source).toContain("/Type /Catalog")
      expect(source).toContain(`/Count ${created.metadata.pages}`)
      expect(source).toContain("xref\n0 ")
      expect(source).toContain("startxref")
      expect(source).toEndWith("%%EOF\n")
      expect(source).toContain("<517561727465726C7920726576696577>".toUpperCase())
      expect(source).toContain("<4D6574726963>")
      expect(source).toContain(" re S")
      expect(source).toContain("/Subtype /Image")
      expect(source).toContain("/SMask ")
      expect(source).toContain("/FlateDecode")
      expect(source).toContain("/Figure << /Alt <517561727465726C7920737461747573206D61726B6572>")
      expect(source).toContain("/Im4 Do")
      const start = Number(source.match(/startxref\n(\d+)/)?.[1])
      expect(source.slice(start)).toStartWith("xref\n")
      const offsets = [...source.matchAll(/(\d{10}) 00000 n \n/g)].map((match) => Number(match[1]))
      expect(offsets.length).toBeGreaterThan(4)
      for (const [index, offset] of offsets.entries()) expect(source.slice(offset)).toStartWith(`${index + 1} 0 obj\n`)

      const before = bytes.slice()
      const denied = yield* defs.pdf
        .execute(
          { filePath: target, blocks: [{ type: "paragraph", text: "Must not replace" }] },
          { ...ctx, ask: () => Effect.die(new Error("Denied by fixture approval boundary")) },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(new Uint8Array(yield* Effect.promise(() => Bun.file(target).arrayBuffer()))).toEqual(before)
      for (const input of [
        { filePath: path.join(instance.directory, "wrong.docx"), blocks: [{ type: "paragraph", text: "No" }] },
        { filePath: path.join(instance.directory, "blank.pdf"), blocks: [{ type: "paragraph", text: "   " }] },
        {
          filePath: path.join(instance.directory, "unicode.pdf"),
          blocks: [{ type: "paragraph", text: "Unsupported 😀" }],
        },
        {
          filePath: path.join(instance.directory, "ragged.pdf"),
          blocks: [{ type: "table", rows: [["A", "B"], ["Only one"]] }],
        },
        {
          filePath: path.join(instance.directory, "empty-table.pdf"),
          blocks: [{ type: "table", rows: [["", "   "]] }],
        },
        {
          filePath: path.join(instance.directory, "too-many-cells.pdf"),
          blocks: Array.from({ length: 251 }, () => ({
            type: "table" as const,
            rows: [["1", "2", "3", "4", "5", "6", "7", "8"]],
          })),
        },
        {
          filePath: path.join(instance.directory, "too-many-images.pdf"),
          blocks: Array.from({ length: 11 }, (_, index) => ({
            type: "image" as const,
            filePath: image,
            alt: `Image ${index + 1}`,
          })),
        },
      ]) {
        expect(Exit.isFailure(yield* defs.pdf.execute(input, ctx).pipe(Effect.exit))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(input.filePath).exists())).toBe(false)
      }
      expect(approvals).toEqual(["read", "edit"])

      const corrupt = path.join(instance.directory, "corrupt.png")
      const invalid = path.join(instance.directory, "invalid-image.pdf")
      yield* Effect.promise(() => Bun.write(corrupt, "not a png"))
      expect(
        Exit.isFailure(
          yield* defs.pdf
            .execute({ filePath: invalid, blocks: [{ type: "image", filePath: corrupt, alt: "Corrupt image" }] }, ctx)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(invalid).exists())).toBe(false)
      expect(approvals).toEqual(["read", "edit", "read"])
    }),
  60_000,
)

it.instance(
  "creates and extracts a structured PPTX with a complete package and artifact receipt",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const defs = yield* definitions
      const bound = bind([defs.read, defs.presentation, defs.discover])
      yield* prepare(bound.tools)
      const target = path.join(instance.directory, "launch-plan.pptx")
      const image = path.join(instance.directory, "workflow.png")
      yield* Effect.promise(() =>
        Bun.write(
          image,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
            "base64",
          ),
        ),
      )
      const approvals: string[] = []
      const ctx = {
        ...bound.ctx,
        ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
          Effect.sync(() => {
            approvals.push(request.permission)
          }),
      }
      expect(CapabilityCatalog.inspect(bound.ctx, { query: "create PowerPoint" }).capabilities[0]).toMatchObject({
        id: "presentations.create",
        status: "available",
        tools: ["create_presentation"],
      })
      const created = yield* defs.presentation.execute(
        {
          filePath: target,
          title: "Launch plan",
          author: "Raya",
          slides: [
            { title: "A calmer launch", subtitle: "One clear outcome", body: "Ship what matters & measure it." },
            { title: "The sequence", points: ["Invite the first cohort", "Review what changed"], ordered: true },
            {
              title: "Owners and outcomes",
              table: {
                rows: [
                  ["Owner", "Outcome"],
                  ["Design", "A clear flow"],
                  ["Engineering", "A verified build"],
                  ["Notes", ""],
                ],
              },
            },
            {
              title: "Workflow status",
              image: {
                filePath: image,
                alt: "Workflow status mark",
                caption: "The current workflow is ready for review.",
                width: 2,
              },
            },
          ],
        },
        ctx,
      )
      expect(created.output).toBe("Created launch-plan.pptx with 4 slides.")
      expect(created.metadata).toMatchObject({
        filepath: target,
        exists: false,
        slides: 4,
        cells: 8,
        images: 1,
        rayaRevision: { version: 1, status: "captured", path: target },
      })
      const bytes = new Uint8Array(yield* Effect.promise(() => Bun.file(target).arrayBuffer()))
      const archive = new ZipReader(new Uint8ArrayReader(bytes))
      const items = yield* Effect.promise(() => archive.getEntries())
      expect(items.map((item) => item.filename)).toEqual(
        expect.arrayContaining([
          "[Content_Types].xml",
          "_rels/.rels",
          "ppt/presentation.xml",
          "ppt/_rels/presentation.xml.rels",
          "ppt/slideMasters/slideMaster1.xml",
          "ppt/slideLayouts/slideLayout1.xml",
          "ppt/theme/theme1.xml",
          "ppt/slides/slide1.xml",
          "ppt/slides/slide2.xml",
          "ppt/slides/slide3.xml",
          "ppt/slides/slide4.xml",
          "ppt/slides/_rels/slide4.xml.rels",
          "ppt/media/image1.png",
        ]),
      )
      const entry = items.find((item) => item.filename === "ppt/slides/slide3.xml")
      expect(entry?.getData).toBeDefined()
      const xml = yield* Effect.promise(() => entry!.getData!(new TextWriter()))
      const picture = items.find((item) => item.filename === "ppt/slides/slide4.xml")
      const relationships = items.find((item) => item.filename === "ppt/slides/_rels/slide4.xml.rels")
      const media = items.find((item) => item.filename === "ppt/media/image1.png")
      expect(picture?.getData).toBeDefined()
      expect(relationships?.getData).toBeDefined()
      expect(media?.getData).toBeDefined()
      const visual = yield* Effect.promise(() => picture!.getData!(new TextWriter()))
      const links = yield* Effect.promise(() => relationships!.getData!(new TextWriter()))
      const embedded = yield* Effect.promise(() => media!.getData!(new Uint8ArrayWriter()))
      yield* Effect.promise(() => archive.close())
      expect(xml).toContain("<a:tbl>")
      expect(xml).toContain('firstRow="1"')
      expect(xml).toContain('val="E8EBF0"')
      expect(xml).toContain('typeface="Outfit"')
      const read = yield* defs.read.execute({ filePath: target }, ctx)
      expect(visual).toContain("<p:pic>")
      expect(visual).toContain('descr="Workflow status mark"')
      expect(visual).toContain('r:embed="rId2"')
      expect(visual).toContain("The current workflow is ready for review.")
      expect(links).toContain('Target="../media/image1.png"')
      expect(embedded).toEqual(new Uint8Array(yield* Effect.promise(() => Bun.file(image).arrayBuffer())))
      expect(read.output).toContain("--- Slide: 1 ---")
      expect(read.output).toContain("A calmer launch")
      expect(read.output).toContain("Ship what matters & measure it.")
      expect(read.output).toContain("--- Slide: 2 ---")
      expect(read.output).toContain("Invite the first cohort")
      expect(read.output).toContain("--- Slide: 3 ---")
      for (const value of ["Owners and outcomes", "Owner", "Outcome", "Design", "A clear flow", "Engineering"])
        expect(read.output).toContain(value)
      expect(read.output).toContain("--- Slide: 4 ---")
      expect(read.output).toContain("Workflow status")
      expect(read.output).toContain("The current workflow is ready for review.")
      expect(approvals).toEqual(["read", "edit", "read"])

      const before = yield* Effect.promise(() => Bun.file(target).arrayBuffer())
      const denied = yield* defs.presentation
        .execute(
          { filePath: target, slides: [{ title: "must not replace" }] },
          { ...ctx, ask: () => Effect.die(new Error("Denied by fixture approval boundary")) },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(target).arrayBuffer())).toEqual(before)
      const replaced = yield* defs.presentation.execute(
        { filePath: target, slides: [{ title: "Revised deck", body: "Approved replacement" }] },
        ctx,
      )
      expect(replaced.metadata).toMatchObject({ filepath: target, exists: true, slides: 1 })
      const reread = yield* defs.read.execute({ filePath: target }, ctx)
      expect(reread.output).toContain("Revised deck")
      expect(reread.output).toContain("Approved replacement")
      expect(reread.output).not.toContain("A calmer launch")
      for (const input of [
        { filePath: path.join(instance.directory, "wrong.pdf"), slides: [{ title: "No" }] },
        { filePath: path.join(instance.directory, "blank.pptx"), slides: [{ title: "   " }] },
        {
          filePath: path.join(instance.directory, "mixed.pptx"),
          slides: [{ title: "Crowded", body: "Body", table: { rows: [["Table"]] } }],
        },
        {
          filePath: path.join(instance.directory, "ragged.pptx"),
          slides: [{ title: "Ragged", table: { rows: [["A", "B"], ["C"]] } }],
        },
        {
          filePath: path.join(instance.directory, "mixed-image.pptx"),
          slides: [{ title: "Crowded image", body: "Body", image: { filePath: image, alt: "Visual" } }],
        },
      ]) {
        expect(Exit.isFailure(yield* defs.presentation.execute(input, ctx).pipe(Effect.exit))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(input.filePath).exists())).toBe(false)
      }
      const oversized = path.join(instance.directory, "oversized.pptx")
      const rows = Array.from({ length: 12 }, () => Array.from({ length: 6 }, () => "Bounded"))
      const slides = Array.from({ length: 5 }, (_, index) => ({ title: `Table ${index + 1}`, table: { rows } }))
      expect(
        Exit.isFailure(yield* defs.presentation.execute({ filePath: oversized, slides }, ctx).pipe(Effect.exit)),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(oversized).exists())).toBe(false)
      const tooMany = path.join(instance.directory, "too-many-images.pptx")
      expect(
        Exit.isFailure(
          yield* defs.presentation
            .execute(
              {
                filePath: tooMany,
                slides: Array.from({ length: 21 }, (_, index) => ({
                  title: `Image ${index + 1}`,
                  image: { filePath: image, alt: `Visual ${index + 1}` },
                })),
              },
              ctx,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(tooMany).exists())).toBe(false)
      const corrupt = path.join(instance.directory, "corrupt.png")
      const invalid = path.join(instance.directory, "invalid-image.pptx")
      yield* Effect.promise(() => Bun.write(corrupt, "not a png"))
      expect(
        Exit.isFailure(
          yield* defs.presentation
            .execute(
              { filePath: invalid, slides: [{ title: "Invalid", image: { filePath: corrupt, alt: "Corrupt" } }] },
              ctx,
            )
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(invalid).exists())).toBe(false)
    }),
  60_000,
)

it.instance(
  "creates a readable multi-sheet XLSX with a verified artifact receipt",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const defs = yield* definitions
      const bound = bind([defs.read, defs.spreadsheet, defs.discover])
      yield* prepare(bound.tools)
      const target = path.join(instance.directory, "quarterly-report.xlsx")
      const approvals: string[] = []
      const ctx = {
        ...bound.ctx,
        ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
          Effect.sync(() => {
            approvals.push(request.permission)
          }),
      }
      const discovery = CapabilityCatalog.inspect(bound.ctx, { query: "create Excel" })
      expect(discovery.capabilities[0]).toMatchObject({
        id: "spreadsheets.create",
        status: "available",
        tools: ["create_spreadsheet"],
      })
      const created = yield* defs.spreadsheet.execute(
        {
          filePath: target,
          sheets: [
            {
              name: "Summary",
              rows: [
                ["Region", "Revenue", "Margin", "Approved"],
                ["North", { number: 1250.5, format: "usd" }, { number: 0.175, format: "percent", decimals: 1 }, true],
                ["South", { number: 980, format: "cad", decimals: 0 }, { number: 0.2, format: "percent" }, false],
                ["Total", { formula: "SUM(B2:B3)", value: 2230.5, format: "usd" }, null, null],
              ],
            },
            {
              name: "Notes",
              header: false,
              rows: [["Values are final."], [null, "Reviewed"], ["As of", { date: "2026-09-13" }]],
            },
          ],
        },
        ctx,
      )
      expect(created.output).toBe("Created 2 sheets in quarterly-report.xlsx.")
      expect(created.metadata).toMatchObject({
        filepath: target,
        exists: false,
        sheets: ["Summary", "Notes"],
        cells: 21,
        formulas: 1,
        dates: 1,
        formats: 5,
        rayaRevision: { version: 1, status: "captured", path: target },
      })
      const book = parseWorkbook(yield* Effect.promise(() => Bun.file(target).arrayBuffer()), {
        type: "array",
        cellNF: true,
      })
      expect(book.Sheets.Summary?.B4).toMatchObject({
        f: "SUM(B2:B3)",
        v: 2230.5,
        t: "n",
        z: "[$$-409]#,##0.00",
      })
      expect(book.Sheets.Summary?.B2).toMatchObject({ v: 1250.5, t: "n", z: "[$$-409]#,##0.00" })
      expect(book.Sheets.Summary?.C2).toMatchObject({ v: 0.175, t: "n", z: "0.0%", w: "17.5%" })
      expect(book.Sheets.Summary?.B3).toMatchObject({ v: 980, t: "n", z: "[$$-1009]#,##0" })
      expect(book.Sheets.Notes?.B3).toMatchObject({ v: 46_278, t: "n", w: "2026-09-13" })
      const read = yield* defs.read.execute({ filePath: target }, ctx)
      expect(read.output).toContain("--- Sheet: Summary ---")
      expect(read.output).toContain("North\t$1,250.50\t17.5%\tTRUE")
      expect(read.output).toContain("Total\t$2,230.50")
      expect(read.output).toContain("--- Sheet: Notes ---")
      expect(read.output).toContain("Values are final.")
      expect(read.output).toContain("As of\t2026-09-13")
      expect(approvals).toEqual(["edit", "read"])

      const before = yield* Effect.promise(() => Bun.file(target).arrayBuffer())
      const denied = yield* defs.spreadsheet
        .execute(
          { filePath: target, sheets: [{ name: "Replacement", rows: [["must not replace"]] }] },
          { ...ctx, ask: () => Effect.die(new Error("Denied by fixture approval boundary")) },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(target).arrayBuffer())).toEqual(before)
      const replaced = yield* defs.spreadsheet.execute(
        { filePath: target, sheets: [{ name: "Replacement", rows: [["Current"], [42]] }] },
        ctx,
      )
      expect(replaced.metadata).toMatchObject({ filepath: target, exists: true, sheets: ["Replacement"], cells: 2 })
      const reread = yield* defs.read.execute({ filePath: target }, ctx)
      expect(reread.output).toContain("--- Sheet: Replacement ---")
      expect(reread.output).toContain("2: Current\n3: 42")
      expect(reread.output).not.toContain("--- Sheet: Summary ---")
      for (const input of [
        { filePath: path.join(instance.directory, "wrong.csv"), sheets: [{ name: "Data", rows: [[1]] }] },
        {
          filePath: path.join(instance.directory, "duplicate.xlsx"),
          sheets: [
            { name: "Data", rows: [[1]] },
            { name: "data", rows: [[2]] },
          ],
        },
        { filePath: path.join(instance.directory, "invalid.xlsx"), sheets: [{ name: "Sales/2026", rows: [[1]] }] },
        {
          filePath: path.join(instance.directory, "unsafe-formula.xlsx"),
          sheets: [{ name: "Data", rows: [[{ formula: 'HYPERLINK("https://example.com")', value: "Open" }]] }],
        },
        {
          filePath: path.join(instance.directory, "equals-formula.xlsx"),
          sheets: [{ name: "Data", rows: [[{ formula: "=SUM(A1:A2)", value: 3 }]] }],
        },
        {
          filePath: path.join(instance.directory, "invalid-date.xlsx"),
          sheets: [{ name: "Data", rows: [[{ date: "2026-02-29" }]] }],
        },
        {
          filePath: path.join(instance.directory, "invalid-format.xlsx"),
          sheets: [{ name: "Data", rows: [[{ number: 42, format: "usd", decimals: 5 }]] }],
        },
        {
          filePath: path.join(instance.directory, "text-format.xlsx"),
          sheets: [{ name: "Data", rows: [[{ formula: "IF(TRUE,1,0)", value: "one", format: "number" }]] }],
        },
      ]) {
        expect(Exit.isFailure(yield* defs.spreadsheet.execute(input, ctx).pipe(Effect.exit))).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(input.filePath).exists())).toBe(false)
      }
    }),
  60_000,
)
