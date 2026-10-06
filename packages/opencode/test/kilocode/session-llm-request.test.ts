import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Agent } from "@/agent/agent"
import type { Auth } from "@/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import { SystemPrompt } from "@/session/system"
import { RayaChief } from "@/kilocode/chief"
import { TurnTools } from "@/kilocode/capability/turn-tools"
import { KilocodeSystemPrompt } from "@/kilocode/system-prompt"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Parameters } from "@/kilocode/tool/chief-route"
import { ToolJsonSchema } from "@/tool/json-schema"
import { asSchema } from "ai"
import { Schema } from "effect"
import { createRequire } from "node:module"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent as AgentService } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { SessionTools } from "@/session/tools"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Parameters as TaskParameters } from "@/tool/task"
import { TaskSchema } from "@/kilocode/tool/task-schema"
import { FileGuidance } from "@/kilocode/tool/file-guidance"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      AgentService.node,
      Provider.node,
      Session.node,
      Permission.node,
      SessionProjector.node,
      ToolRegistry.node,
      SessionProcessor.node,
      SessionPrompt.node,
      Plugin.node,
      MCP.node,
      Config.node,
      Truncate.node,
      RuntimeFlags.node,
      Database.node,
      CrossSpawnSpawner.node,
      EventV2Bridge.node,
    ]),
  ),
)

it.instance("file guidance survives actual native and completion-envelope request preparation", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const items = yield* registry.all()
    const named = Object.fromEntries(items.map((item) => [item.id, item]))
    const sessions = yield* Session.Service
    const agents = yield* AgentService.Service
    const processors = yield* SessionProcessor.Service
    const prompts = yield* SessionPrompt.Service
    const ctx = yield* InstanceState.context
    const who = yield* agents.get("code")
    if (!who) throw new Error("Actual code agent required")
    const session = yield* sessions.create()
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      agent: who.name,
      model: { providerID: model.providerID, modelID: model.id },
      time: { created: Date.now() },
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      parentID: user.id,
      sessionID: session.id,
      role: "assistant",
      mode: who.name,
      agent: who.name,
      cost: 0,
      path: { cwd: ctx.directory, root: ctx.directory },
      providerID: model.providerID,
      modelID: model.id,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    })
    const processor = yield* processors.create({ assistantMessage: assistant, sessionID: session.id, model })
    const catalog = yield* SessionTools.resolve({
      agent: who,
      model,
      session,
      processor,
      messages: yield* sessions.messages({ sessionID: session.id }),
      bypassAgentCheck: false,
      promptOps: {
        cancel: prompts.cancel,
        resolvePromptParts: prompts.resolvePromptParts,
        prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
      },
      memoryCache: {},
    })
    const tools: Record<string, Tool> = {}
    for (const id of ["read", "write", "edit", "task"]) {
      const item = named[id]
      const schema = ToolJsonSchema.fromTool(item)
      const value = FileGuidance.description(id, item.description)
      expect(value.startsWith(item.description)).toBe(true)
      const description = catalog[id].description
      if (!description) throw new Error("Actual tool description required")
      if (id === "task") expect(FileGuidance.description(id, description)).toBe(description)
      if (id !== "task") expect(catalog[id].description).toBe(value)
      expect(asSchema(catalog[id].inputSchema).jsonSchema).toEqual(ProviderTransform.schema(model, schema))
      tools[id] = catalog[id]
    }
    expect(FileGuidance.description("custom_read", "Custom tool")).toBe("Custom tool")
    for (const oauth of [false, true]) {
      const result = yield* Effect.promise(() => prepare("code", oauth, tools))
      const definitions = Object.entries(result.tools).map(([id, item]) => ({
        function: {
          name: id,
          description: item.description,
          parameters: { ...asSchema(item.inputSchema).jsonSchema },
        },
      }))
      const guide = ToolEnvelope.guide(definitions)
      for (const id of ["read", "write", "edit"]) {
        const value = result.tools[id].description
        expect(value).toBe(tools[id].description)
        expect(value).toContain("Outer display line-number prefixes, XML wrappers")
        expect(value).toContain("Do not copy these decorations")
        expect(value).toContain("do not automatically strip file data")
        expect(value).toContain("does not establish original newline endings, final newline or encoding")
        expect(value).toContain("say exact byte equality is unverified")
        expect(value).toContain("report any mismatch or unavailable verification")
        expect(guide).toContain(JSON.stringify(value))
        expect(asSchema(result.tools[id].inputSchema).jsonSchema).toEqual(asSchema(tools[id].inputSchema).jsonSchema)
      }
      expect(result.tools.task.description).toBe(catalog.task.description)
      expect(ToolEnvelope.schema(definitions, "required").anyOf).toHaveLength(5)
    }
  }),
)

it.instance("actual Task advertisement requires fresh objectives through native and Ollama envelope preparation", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const task = (yield* registry.named()).task
    const schema = ToolJsonSchema.fromTool(task)
    const tools = { task: aiTool({ inputSchema: jsonSchema(schema), execute: async () => "ok" }) }
    const native = yield* Effect.promise(() => prepare("auto", false, tools))
    const oauth = yield* Effect.promise(() => prepare("auto", true, tools))
    const require = createRequire(import.meta.url)
    type Validator = { compile(schema: unknown): (value: unknown) => boolean }
    const Constructor = createRequire(require.resolve("effect/package.json"))("ajv/dist/2020") as new (options: {
      strict: boolean
    }) => Validator
    const validator = new Constructor({ strict: false })
    // The original model advertisement was the unchanged optional runtime schema.
    expect(validator.compile(ToolJsonSchema.fromSchema(TaskParameters))({ access: "edit" })).toBe(true)
    const shapes = [
      schema,
      asSchema(native.tools.task.inputSchema).jsonSchema,
      asSchema(oauth.tools.task.inputSchema).jsonSchema,
    ]
    const invalid = [
      {},
      { description: "Label only", access: "edit" },
      { prompt: " \n\t" },
      { brief: { objective: " " } },
      { task_id: "" },
      { branch_id: "" },
    ]
    const valid = [
      { prompt: "Read the source" },
      { brief: { objective: "Write and verify the result" }, access: "edit" },
      { task_id: "ses_saved" },
      { branch_id: "saved-branch" },
    ]
    for (const shape of shapes) {
      const check = validator.compile(shape)
      for (const value of invalid) expect(check(value)).toBe(false)
      for (const value of valid) expect(check(value)).toBe(true)
      const envelope = validator.compile(
        ToolEnvelope.schema([{ function: { name: "task", parameters: { ...shape } } }], "required"),
      )
      for (const value of invalid) expect(envelope({ kind: "tool", name: "task", arguments: value })).toBe(false)
      for (const value of valid) expect(envelope({ kind: "tool", name: "task", arguments: value })).toBe(true)
    }
    expect(task.parameters).toBe(TaskParameters)
    expect(Schema.decodeUnknownSync(TaskParameters)({})).toEqual({})
    const background = validator.compile(TaskSchema.objective(ToolJsonSchema.fromSchema(TaskParameters)))
    expect(background({ background: true })).toBe(false)
    expect(background({ background: true, brief: { objective: "Complete the assigned subwork" } })).toBe(true)
  }),
)

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: {
    id: "test-model",
    url: "https://example.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "Test model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const plugin: Plugin.Interface = {
  init: () => Effect.void,
  trigger: (_name, _input, output) => Effect.succeed(output),
  list: () => Effect.succeed([]),
}

function agent(name: string): Agent.Info {
  return {
    name,
    mode: "primary",
    options: {},
    permission: [],
    prompt: name === "auto" ? RayaChief.prompt([]) : `${name} generation prompt`,
  }
}

function user(name: string): SessionV1.User {
  return {
    id: MessageID.make("msg_test"),
    sessionID: SessionID.make("ses_test"),
    role: "user",
    time: { created: Date.now() },
    agent: name,
    model: { providerID: model.providerID, modelID: model.id },
    system: "request-specific system text",
  }
}

async function prepare(name: string, oauth = false, tools: Record<string, Tool> = {}, system: string[] = []) {
  const auth: Auth.Info | undefined = oauth
    ? { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 }
    : undefined
  const provider: Provider.Info = {
    id: ProviderV2.ID.make(oauth ? "openai" : "test"),
    name: "Test provider",
    source: "config",
    env: [],
    options: {},
    models: {},
  }
  const flags = await Effect.runPromise(
    RuntimeFlags.Service.pipe(Effect.provide(RuntimeFlags.layer({ client: "test" }))),
  )
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: user(name),
      sessionID: "ses_test",
      model,
      agent: agent(name),
      system,
      messages: [{ role: "user", content: "Generate a name" }] satisfies ModelMessage[],
      tools,
      provider,
      auth,
      plugin,
      flags,
      isWorkflow: false,
    }),
  )
}

test("actual request preparation retains delegated backend directory without editor context", async () => {
  const directory = "C:\\private workspace\\child"
  const worktree = "C:\\"
  const system = KilocodeSystemPrompt.environment({
    ctx: {
      directory,
      worktree,
      project: { id: ProjectV2.ID.make("global"), worktree, time: { created: 0, updated: 0 }, sandboxes: [] },
    },
    model,
  })
  expect(user("code").editorContext).toBeUndefined()
  const result = await prepare("code", false, {}, system)
  expect(result.system.join("\n")).toContain(`Working directory: ${directory}`)
  expect(result.system.join("\n")).toContain(`Worktree root: ${worktree}`)
  expect(result.system.join("\n")).not.toContain(`Workspace root folder: ${worktree}`)
  const oauth = await prepare("code", true, {}, system)
  expect(oauth.params.options.instructions).toContain(`Working directory: ${directory}`)
})

describe("Kilo persona in generated metadata requests", () => {
  test.each(["title", "branch-name"])("omits the persona for %s generation", async (name) => {
    const result = await prepare(name)

    expect(result.system[0]).toContain(`${name} generation prompt`)
    expect(result.system[0]).toContain("request-specific system text")
    expect(result.system[0]).not.toContain(SystemPrompt.soul())
  })

  test.each(["title", "branch-name"])("omits the persona from OpenAI OAuth %s generation", async (name) => {
    const result = await prepare(name, true)

    expect(result.params.options.instructions).toContain(`${name} generation prompt`)
    expect(result.params.options.instructions).toContain("request-specific system text")
    expect(result.params.options.instructions).not.toContain(SystemPrompt.soul())
  })

  test("keeps the persona for ordinary agent requests", async () => {
    const result = await prepare("code")
    const oauth = await prepare("code", true)

    expect(result.system[0]).toContain(SystemPrompt.soul())
    expect(oauth.params.options.instructions).toContain(SystemPrompt.soul())
  })
})

describe("current turn tool registry", () => {
  const executable = aiTool({
    description: "Fixture tool",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => "ok",
  })

  test("adds the sorted final registry to ordinary and OAuth prompts", async () => {
    const tools = { write: executable, read: executable }
    const result = await prepare("code", false, tools)
    const oauth = await prepare("code", true, tools)

    expect(result.system.at(-1)).toContain("Current turn tool registry (authoritative): read, write.")
    expect(oauth.params.options.instructions).toContain("Current turn tool registry (authoritative): read, write.")
    expect(result.system.at(-1)).toContain("earlier in the conversation")
  })

  test("makes an empty registry explicit and gives bounded local rejection guidance", async () => {
    const result = await prepare("code")

    expect(result.system.at(-1)).toContain("no tools are available")
    expect(TurnTools.unavailable("bash", ["write", "_noop", "read", "read"])).toBe(
      'Tool "bash" is unavailable in the current turn. Available tools: read, write. Do not retry the unavailable tool name.',
    )
  })
})

describe("Chief work-class request preparation", () => {
  test("carries the real route schema and explicit work guidance to native and OAuth requests", async () => {
    const schema = ToolJsonSchema.fromSchema(Parameters)
    const route = aiTool({ inputSchema: jsonSchema(schema), execute: async () => "ok" })
    const selected = RayaChief.tools(
      { chief_route: route },
      { [RayaChief.phaseKey]: "route", [RayaChief.requestKey]: "Write the requested file" },
    )
    const result = await prepare("auto", false, selected)
    const oauth = await prepare("auto", true, selected)
    expect(Object.keys(result.tools)).toEqual(["chief_route"])
    expect(asSchema(result.tools.chief_route.inputSchema).jsonSchema).toEqual(schema)
    expect(result.system.at(-1)).toContain("Set access explicitly")
    expect(result.system.at(-1)).toContain("edit for requested file changes")
    expect(result.system.at(-1)).toContain("Omitting access does not classify the requested work")
    expect(result.messages.at(-2)?.content).toBe(result.system.at(-1))
    expect(oauth.params.options.instructions).toContain(result.system.at(-1))
    const property = schema.properties?.access
    expect(typeof property).toBe("object")
    if (!property || typeof property !== "object") throw new Error("Access schema required")
    expect(property.description).toContain("Required work class")
    for (const access of ["read", "edit", "computer"] as const)
      expect(Schema.decodeUnknownSync(Parameters)({ objective: "Complete request", access }).access).toBe(access)
    expect(() => Schema.decodeUnknownSync(Parameters)({ objective: "Missing work class" })).toThrow()
    const task = await prepare("auto", false, { task: route })
    expect(task.system.at(-1)).toContain("Carry the selected Chief access into Task")
    expect(task.system.at(-1)).toContain("omission never grants permission to edit")
  })
})

describe("Auto routing turn guidance", () => {
  const executable = aiTool({
    description: "Fixture executable tool",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => "ok",
  })
  test("prepares the actual route-only selection as the final authoritative instruction", async () => {
    const available = {
      chief_route: executable,
      read: executable,
      write: executable,
      edit: executable,
      get_goal: executable,
      update_goal: executable,
      task: executable,
    }
    const selected = RayaChief.tools(available, {
      [RayaChief.phaseKey]: RayaChief.begin(undefined),
      [RayaChief.requestKey]: "Inspect the requested local file",
    })
    const result = await prepare("auto", false, selected)
    expect(Object.keys(result.tools)).toEqual(["chief_route"])
    expect(result.system.at(-1)).toContain("This turn is only for routing the current request")
    expect(result.system.at(-1)).toContain("objective containing the complete current user request")
    expect(result.messages.at(-2)?.role).toBe("system")
    expect(result.messages.at(-2)?.content).toBe(result.system.at(-1))
    const oauth = await prepare("auto", true, selected)
    expect(oauth.params.options.instructions).toContain(result.system.at(-1))
  })
  test("does not instruct a repeated route after a task or verification selection", async () => {
    const available = { chief_route: executable, get_goal: executable, task: executable, read: executable }
    for (const phase of ["task", "verify"] as const) {
      const result = await prepare("auto", false, RayaChief.tools(available, { [RayaChief.phaseKey]: phase }))
      expect(result.system.at(-1)).not.toContain("This turn is only for routing")
    }
    expect(TurnTools.prompt(["read", "write"])).not.toContain("This turn is only for routing")
    expect(TurnTools.prompt([])).not.toContain("This turn is only for routing")
  })
})

describe("Task delegation turn guidance", () => {
  const executable = aiTool({
    description: "Fixture executable tool",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => "ok",
  })
  test("guides a fresh ordinary delegation through actual request preparation", async () => {
    const selected = { task: executable, read: executable }
    const result = await prepare("code", false, selected)
    const oauth = await prepare("code", true, selected)
    expect(Object.keys(result.tools)).toEqual(["read", "task"])
    expect(result.system.at(-1)).toContain("provide a nonempty brief.objective or the supported prompt field")
    expect(result.system.at(-1)).toContain("description, subagent_type and access do not supply an objective")
    expect(result.system.at(-1)).toContain("actual saved branch_id or task_id resume")
    expect(result.system.at(-1)).toContain("acknowledged current Chief request or follow-up")
    expect(result.system.at(-1)).toContain("Never invent saved IDs or assume a saved objective exists")
    expect(result.system.at(-1)).toContain("omit task_id and branch_id")
    expect(result.system.at(-1)).toContain("Never send empty strings for these IDs")
    expect(oauth.params.options.instructions).toContain(result.system.at(-1))
    expect(result.messages.at(-2)?.content).toBe(result.system.at(-1))
  })
  test("keeps saved Chief task selection while describing the objective exception", async () => {
    const selected = RayaChief.tools(
      { chief_route: executable, task: executable, get_goal: executable },
      { [RayaChief.phaseKey]: "task", [RayaChief.requestKey]: "Inspect the requested file" },
    )
    const result = await prepare("auto", false, selected)
    expect(Object.keys(result.tools)).toContain("task")
    expect(result.system.at(-1)).toContain("whose objective is already retained")
    expect(result.system.at(-1)).not.toContain("This turn is only for routing")
  })
  test("omits delegation guidance when task is not actually advertised", async () => {
    const cases: Record<string, Tool>[] = [
      {},
      { read: executable },
      { chief_route: executable },
      { task_status: executable },
    ]
    for (const selected of cases) {
      const result = await prepare("code", false, selected)
      expect(result.system.at(-1)).not.toContain("For a fresh task delegation")
    }
    expect(TurnTools.prompt(["_noop"])).not.toContain("For a fresh task delegation")
  })
})

describe("file content display guidance", () => {
  const executable = aiTool({
    description: "Fixture executable tool",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => "ok",
  })
  test.each(["write", "edit"])("guides actual selected read and %s requests without changing tools", async (name) => {
    const tools = { read: executable, [name]: executable }
    const result = await prepare("code", false, tools)
    const oauth = await prepare("code", true, tools)
    expect(Object.keys(result.tools).sort()).toEqual([name, "read"].sort())
    expect(result.system.at(-1)).toContain("numbered line labels such as '1: '")
    expect(result.system.at(-1)).toContain("final-newline state when known")
    expect(result.system.at(-1)).toContain("do not invent formatting or claim byte-exact verification")
    expect(result.system.at(-1)).toContain("Follow the user's requested changes")
    expect(oauth.params.options.instructions).toContain(result.system.at(-1))
  })
  test("omits file-copy guidance outside actual read/write selections", () => {
    for (const tools of [[], ["read"], ["write"], ["edit"], ["chief_route"], ["task", "get_goal"]]) {
      expect(TurnTools.prompt(tools)).not.toContain("Read tool file output is a display")
    }
  })
})
