import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { jsonSchema, tool, type Tool as AITool } from "ai"
import { utils, write as workbook } from "xlsx"
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
