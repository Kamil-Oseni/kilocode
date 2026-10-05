import { expect, test } from "bun:test"
import { z } from "zod"
import { KiloToolSchema } from "@/kilocode/session/tool-schema"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionTools } from "@/session/tools"
import { MessageID, PartID } from "@/session/schema"
import { ChiefRouteTool } from "@/kilocode/tool/chief-route"
import { LLMRequestPrep } from "@/session/llm/request"
import { RayaChief } from "@/kilocode/chief"
import { HomeAssistant } from "@/kilocode/home-assistant/tools"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { Bridge } from "../../../kilo-vscode/src/home-assistant/bridge"
import { Lights } from "../../../kilo-vscode/src/home-assistant/client"
import { Journal } from "../../../kilo-vscode/src/home-assistant/journal"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Provider.node,
      Session.node,
      SessionProcessor.node,
      SessionPrompt.node,
      ToolRegistry.node,
      Plugin.node,
      Permission.node,
      Question.node,
      Config.node,
      MCP.node,
      Truncate.node,
      RuntimeFlags.node,
      Database.node,
      CrossSpawnSpawner.node,
      SessionProjector.node,
      EventV2Bridge.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
  ),
)
const cfg = {
  snapshot: false,
  enabled_providers: ["local"],
  permission: { edit: "allow" as const },
  plugin: [],
  mcp: {},
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { baseURL: "http://127.0.0.1:11434/v1", localInference: true, localInferenceAPI: "ollama" },
      models: { fixture: { name: "fixture", limit: { context: 32768, output: 1024 } } },
    },
  },
} satisfies Partial<Config.Info>

test("selected home workflow admits bounded mood tools and theme research without arbitrary device transport", () => {
  const available = {
    raya_home_assistant_moods_list: {},
    raya_home_assistant_moods_save: {},
    raya_home_assistant_moods_start: {},
    raya_home_assistant_moods_stop: {},
    websearch: {},
    webfetch: {},
    arbitrary_http: {},
    bash: {},
    task: {},
  }
  expect(Object.keys(HomeAssistant.tools(available)).sort()).toEqual([
    "raya_home_assistant_moods_list",
    "raya_home_assistant_moods_save",
    "raya_home_assistant_moods_start",
    "raya_home_assistant_moods_stop",
    "webfetch",
    "websearch",
  ])
  const denied = Permission.fromConfig({ raya_home_assistant_moods_start: "deny" })
  expect(Permission.evaluate("raya_home_assistant_moods_start", "*", HomeAssistant.rules(denied)).action).toBe("deny")
  expect(Permission.evaluate("raya_home_assistant_moods_save", "*", HomeAssistant.rules([])).action).toBe("ask")
})

it.live(
  "Auto exposes only registered home tools and retains child ceilings",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const provider = yield* Provider.Service
          const processors = yield* SessionProcessor.Service
          const prompts = yield* SessionPrompt.Service
          const plugin = yield* Plugin.Service
          const flags = yield* RuntimeFlags.Service
          const agent = yield* agents.get("auto")
          if (!agent) throw new Error("Auto agent missing")
          const model = yield* provider.getModel(ProviderV2.ID.make("local"), ModelV2.ID.make("fixture"))
          const session = yield* sessions.create()
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "auto",
            model: { providerID: model.providerID, modelID: model.id },
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            parentID: user.id,
            sessionID: session.id,
            role: "assistant",
            mode: "auto",
            agent: "auto",
            cost: 0,
            path: { cwd: dir, root: dir },
            providerID: model.providerID,
            modelID: model.id,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const processor = yield* processors.create({ assistantMessage: assistant, sessionID: session.id, model })
          const resolve = (metadata = session.metadata, actor = agent) =>
            sessions.messages({ sessionID: session.id }).pipe(
              Effect.flatMap((messages) =>
                SessionTools.resolve({
                  agent: actor,
                  model,
                  session: { ...session, metadata },
                  processor,
                  messages,
                  bypassAgentCheck: false,
                  promptOps: {
                    cancel: prompts.cancel,
                    resolvePromptParts: prompts.resolvePromptParts,
                    prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
                  },
                  memoryCache: {},
                }),
              ),
            )
          const mcp = yield* MCP.Service
          const source = yield* Effect.promise(() =>
            Bun.file(new URL("../../../kilo-vscode/src/home-assistant/bridge.ts", import.meta.url)).text(),
          )
          const names = [...source.matchAll(/name: "(lights_[a-z]+)"/g)].map((match) => match[1])
          expect(names).toEqual(["lights_read", "lights_set", "lights_mode"])
          const keys = names.map((name) => "raya_home_assistant_" + name)
          const before = yield* resolve()
          expect(keys.some((key) => key in before)).toBe(false)
          const server = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const state = { calls: [] as string[] }
              const protocol = new Server(
                { name: "synthetic-home-catalog", version: "1" },
                { capabilities: { tools: {} } },
              )
              protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
                tools: [...names, "arbitrary_http"].map((name) => ({
                  name,
                  description: "Synthetic non-executing catalog",
                  inputSchema: { type: "object", properties: {} },
                })),
              }))
              protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
                state.calls.push(request.params.name)
                return { content: [{ type: "text", text: "Synthetic non-mutating fixture" }] }
              })
              const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                enableJsonResponse: true,
              })
              await protocol.connect(transport)
              const http = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch: (request) => transport.handleRequest(request),
              })
              return {
                state,
                url: http.url.toString(),
                close: async () => {
                  await protocol.close()
                  await http.stop(false)
                },
              }
            }),
            (server) => Effect.promise(server.close),
          )
          const status = yield* mcp.add("raya_home_assistant", { type: "remote", url: server.url, oauth: false })
          expect(status.status).toMatchObject({ raya_home_assistant: { status: "connected" } })
          const tools = yield* resolve()
          const voice = yield* agents.get("voice")
          if (!voice) throw new Error("Voice agent missing")
          const direct = yield* resolve(session.metadata, voice)
          expect(keys.every((key) => key in direct)).toBe(true)
          expect(direct.chief_route).toBeUndefined()
          expect(keys.every((key) => key in tools)).toBe(true)
          expect(tools.raya_home_assistant_lights_get).toBeUndefined()
          const initial = RayaChief.tools(tools, session.metadata, { session: session.id, user: user.id })
          expect(Object.keys(initial)).toEqual(["chief_route"])
          const selected = {
            [RayaChief.requestKey]: "Device request",
            [HomeAssistant.key]: {
              session: session.id,
              user: user.id,
              request: "Device request",
            },
          }
          const chosen = RayaChief.tools(tools, selected, { session: session.id, user: user.id })
          expect(keys.every((key) => key in chosen)).toBe(true)
          expect(chosen.raya_home_assistant_arbitrary_http).toBeUndefined()
          expect(RayaChief.tools(tools, selected, { session: session.id + "foreign", user: user.id })).toEqual(initial)
          expect(RayaChief.tools(tools, selected, { session: session.id, user: MessageID.ascending() })).toEqual(
            initial,
          )
          expect(
            RayaChief.tools(
              tools,
              { ...selected, [RayaChief.requestKey]: "Different request" },
              { session: session.id, user: user.id },
            ),
          ).toEqual(initial)
          const info = yield* provider.getProvider(model.providerID)
          const prepare = (permission = session.permission, who = agent, catalog = chosen) =>
            LLMRequestPrep.prepare({
              user,
              sessionID: session.id,
              model,
              agent: who,
              permission,
              system: [],
              messages: [],
              tools: catalog,
              provider: info,
              auth: undefined,
              plugin,
              flags,
              isWorkflow: false,
            })
          const speech = yield* prepare(session.permission, voice, HomeAssistant.tools(direct))
          expect(keys.every((key) => key in speech.tools)).toBe(true)
          const blocked = yield* prepare(
            Permission.fromConfig({ [keys[1]]: "deny" }),
            voice,
            HomeAssistant.tools(direct),
          )
          expect(blocked.tools[keys[1]]).toBeUndefined()
          expect(blocked.tools[keys[0]]).toBeDefined()
          const schemas = yield* Effect.promise(() => KiloToolSchema.sanitize(speech.tools))
          expect(
            KiloSessionOverflow.measure({ messages: speech.messages, tools: schemas }).normalized +
              (speech.params.maxOutputTokens ?? 0),
          ).toBeLessThan(32768)
          const ready = yield* prepare()
          for (const key of keys) {
            expect(ready.tools[key]).toBeDefined()
            expect(Permission.evaluate(key, "*", agent.permission).action).toBe("ask")
          }
          const denied = yield* prepare(Permission.fromConfig({ [keys[1]]: "deny" }))
          expect(denied.tools[keys[1]]).toBeUndefined()
          expect(denied.tools[keys[0]]).toBeDefined()
          yield* sessions.setPermission({
            sessionID: session.id,
            permission: Permission.fromConfig({ [keys[0]]: "allow", [keys[1]]: "deny" }),
          })
          yield* Effect.promise(() =>
            Promise.resolve(
              ready.tools[keys[0]].execute!(
                {},
                { toolCallId: "allowed-home-read", messages: [], abortSignal: new AbortController().signal },
              ),
            ),
          )
          expect(server.state.calls).toEqual(["lights_read"])
          yield* Effect.promise(async () =>
            expect(
              Promise.resolve(
                ready.tools[keys[1]].execute!(
                  {},
                  { toolCallId: "denied-home", messages: [], abortSignal: new AbortController().signal },
                ),
              ),
            ).rejects.toThrow("prevents you from using this specific tool call"),
          )
          expect(server.state.calls).toEqual(["lights_read"])
          const child = yield* resolve(TaskAuthority.save(session.metadata, "read"))
          for (const key of keys) expect(child[key]).toBeUndefined()
          expect(child.edit).toBeUndefined()
          expect(child.bash).toBeUndefined()
          expect(RayaChief.tools({}, session.metadata)).toEqual({})
        }),
      { config: cfg },
    ),
  { timeout: 30000 },
)

for (const mode of ["auto", "voice"] as const)
  for (const steps of [40, mode === "auto" ? 5 : 4])
    it.live(
      `${mode} finishes a direct HA turn after one mutation at ${steps} steps`,
      () =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          yield* provideTmpdirInstance(
            () =>
              Effect.gen(function* () {
                const state = { value: "off", posts: 0 }
                const http = yield* Effect.acquireRelease(
                  Effect.sync(() =>
                    Bun.serve({
                      hostname: "127.0.0.1",
                      port: 0,
                      fetch: async (request) => {
                        const path = new URL(request.url).pathname
                        if (request.headers.get("authorization") !== "Bearer synthetic-ha-token")
                          return new Response(null, { status: 401 })
                        if (request.method === "GET" && path.startsWith("/api/states/")) {
                          const entity = path.slice("/api/states/".length)
                          return Response.json({
                            entity_id: entity,
                            state: entity.startsWith("scene.") ? "2026-01-01" : state.value,
                            attributes: {},
                          })
                        }
                        if (request.method === "POST" && path === "/api/services/light/turn_on") {
                          const body = (await request.json()) as { entity_id?: string }
                          if (body.entity_id !== "light.pc_rgb") return new Response(null, { status: 400 })
                          state.posts++
                          state.value = "on"
                          return Response.json([])
                        }
                        return new Response(null, { status: 404 })
                      },
                    }),
                  ),
                  (http) => Effect.promise(() => http.stop(false)),
                )
                const storage = new Map<string, unknown>()
                const journal = new Journal({
                  get: <T>(key: string) => storage.get(key) as T | undefined,
                  update: async (key, value) => {
                    storage.set(key, value)
                  },
                })
                const lights = new Lights(
                  "synthetic-ha-token",
                  {
                    version: 1,
                    origin: http.url.origin,
                    entities: ["light.pc_rgb"],
                    modes: [{ name: "movie_mode", entity: "scene.movie_mode" }],
                  },
                  journal,
                )
                const bridge = yield* Effect.acquireRelease(
                  Effect.sync(() => new Bridge(lights)),
                  (bridge) => Effect.promise(() => bridge.dispose()),
                )
                yield* Effect.promise(() => lights.prepare())
                const endpoint = yield* Effect.promise(() => bridge.open())
                const mcp = yield* MCP.Service
                const status = yield* mcp.add("raya_home_assistant", {
                  type: "remote",
                  url: endpoint.url,
                  headers: endpoint.headers,
                  oauth: false,
                })
                expect(status).toMatchObject({ status: { raya_home_assistant: { status: "connected" } } })
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "Direct device fixture" })
                yield* sessions.setPermission({
                  sessionID: session.id,
                  permission: Permission.fromConfig({
                    raya_home_assistant_lights_read: "allow",
                    raya_home_assistant_lights_set: "allow",
                    raya_home_assistant_lights_mode: "allow",
                  }),
                })
                if (mode === "auto")
                  yield* llm.tool("chief_route", {
                    objective: "Turn on the allowed Home Assistant PC light, then report its state.",
                    workflow: "home_assistant",
                    access: "read",
                  })
                yield* llm.tool("raya_home_assistant_lights_read", { entity: "light.pc_rgb" })
                yield* llm.tool("raya_home_assistant_lights_set", { entity: "light.pc_rgb", state: "on" })
                yield* llm.tool("raya_home_assistant_lights_read", { entity: "light.pc_rgb" })
                yield* llm.text("The fixture reports on.")
                const result = yield* prompt.prompt({
                  sessionID: session.id,
                  agent: mode,
                  model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
                  parts: [
                    { type: "text", text: "Turn on the allowed Home Assistant PC light, then report its state." },
                  ],
                })
                expect(result.info.role).toBe("assistant")
                if (result.info.role !== "assistant") throw new Error("Assistant missing")
                expect(result.info.error).toBeUndefined()
                expect(result.info.finish).toBe("stop")
                expect(
                  result.parts.some((part) => part.type === "text" && part.text === "The fixture reports on."),
                ).toBe(true)
                const inputs = yield* llm.inputs
                if (mode === "auto")
                  expect(inputs.map((input) => input.tool_choice)).toEqual([
                    "required",
                    "required",
                    "auto",
                    "auto",
                    steps === 5 ? "none" : "auto",
                  ])
                if (steps === (mode === "auto" ? 5 : 4)) {
                  expect(JSON.stringify(inputs.at(-1))).toContain("MAXIMUM STEPS REACHED")
                  expect(JSON.stringify(inputs.at(-1))).not.toContain(RayaChief.lastStep)
                }
                expect(state.posts).toBe(1)
                expect(journal.pending()).toBeUndefined()
                if (mode === "auto")
                  expect(
                    z
                      .array(z.object({ function: z.object({ name: z.string() }) }))
                      .parse(inputs[0].tools)
                      .map((tool) => tool.function.name),
                  ).toEqual(["chief_route"])
                if (mode === "voice") {
                  const names = z
                    .array(z.object({ function: z.object({ name: z.string() }) }))
                    .parse(inputs[0].tools)
                    .map((item) => item.function.name)
                  expect(names).toContain("raya_home_assistant_lights_read")
                  expect(names).toContain("raya_home_assistant_lights_set")
                  expect(names).not.toContain("chief_route")
                  const messages = yield* sessions.messages({ sessionID: session.id })
                  const parts = messages.flatMap((item) => item.parts).filter((part) => part.type === "tool")
                  expect(parts.map((part) => part.tool)).toEqual([
                    "raya_home_assistant_lights_read",
                    "raya_home_assistant_lights_set",
                    "raya_home_assistant_lights_read",
                  ])
                  expect(parts.every((part) => part.state.status === "completed")).toBe(true)
                  return
                }
                expect(
                  inputs.slice(1, -1).every((input) =>
                    z
                      .array(z.object({ function: z.object({ name: z.string() }) }))
                      .parse(input.tools)
                      .every((tool) => tool.function.name.startsWith("raya_home_assistant_")),
                  ),
                ).toBe(true)
                const messages = yield* sessions.messages({ sessionID: session.id })
                const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
                expect(parts.map((part) => part.tool)).toEqual([
                  "chief_route",
                  "raya_home_assistant_lights_read",
                  "raya_home_assistant_lights_set",
                  "raya_home_assistant_lights_read",
                ])
                expect(parts.every((part) => part.state.status === "completed")).toBe(true)
                const user = messages.findLast((message) => message.info.role === "user")!
                const bound = yield* sessions.get(session.id)
                expect(HomeAssistant.settled(messages, bound, user.info.id)).toBe(true)
                expect(HomeAssistant.settled(messages, { ...bound, parentID: session.id }, user.info.id)).toBe(false)
                expect(HomeAssistant.settled(messages, { id: session.id + "-other" }, user.info.id)).toBe(false)
                expect(HomeAssistant.settled(messages, bound, MessageID.ascending())).toBe(false)
                expect(
                  HomeAssistant.settled(
                    messages.map((message) => ({
                      ...message,
                      info: message.info.role === "user" ? { ...message.info, agent: "ask" } : message.info,
                    })),
                    bound,
                    user.info.id,
                  ),
                ).toBe(false)
                expect(
                  HomeAssistant.settled(
                    messages.map((message) => ({
                      ...message,
                      info: message.info.role === "assistant" ? { ...message.info, agent: "ask" } : message.info,
                    })),
                    bound,
                    user.info.id,
                  ),
                ).toBe(false)
                expect(
                  HomeAssistant.settled(
                    messages.map((message) => ({
                      ...message,
                      parts: message.parts.map((part) =>
                        part.type === "tool" ? { ...part, messageID: MessageID.ascending() } : part,
                      ),
                    })),
                    bound,
                    user.info.id,
                  ),
                ).toBe(false)
                expect(
                  HomeAssistant.settled(
                    messages.map((message) => ({
                      ...message,
                      parts: message.parts.map((part) =>
                        part.type === "tool"
                          ? { ...part, state: { status: "pending" as const, input: {}, raw: "" } }
                          : part,
                      ),
                    })),
                    bound,
                    user.info.id,
                  ),
                ).toBe(false)
                yield* sessions.updateMessage({
                  ...user.info,
                  id: MessageID.ascending(),
                  time: { created: Date.now() },
                })
                const newer = yield* sessions.messages({ sessionID: session.id })
                expect(HomeAssistant.settled(newer, bound, user.info.id)).toBe(false)
              }),
            {
              config: {
                ...cfg,
                agent: { [mode]: { steps } },
                provider: {
                  local: {
                    ...cfg.provider.local,
                    options: { baseURL: llm.url },
                    models: {
                      fixture: {
                        ...cfg.provider.local.models.fixture,
                        limit: { context: 32768, output: 1024 },
                      },
                    },
                  },
                },
              },
            },
          )
        }),
      { timeout: 30000 },
    )

it.live(
  "actual router selects the saved general request and rejects stale device dispatches",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const request = "Read the fixture contents and report exact bytes."
          const session = yield* sessions.create({ metadata: { [RayaChief.requestKey]: request } })
          const model = { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") }
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "auto",
            model,
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: user.id,
            type: "text",
            text: request,
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            parentID: user.id,
            role: "assistant",
            agent: "auto",
            mode: "auto",
            cost: 0,
            path: { cwd: dir, root: dir },
            providerID: model.providerID,
            modelID: model.modelID,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const definition = yield* ChiefRouteTool
          const tool = yield* definition.init()
          const ctx = {
            sessionID: session.id,
            messageID: assistant.id,
            agent: "auto",
            abort: new AbortController().signal,
            messages: yield* sessions.messages({ sessionID: session.id }),
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }
          const catalog = { chief_route: "route", task: "task", raya_home_assistant_lights_read: "device" }
          expect(RayaChief.tools(catalog, session.metadata, { session: session.id, user: user.id })).toEqual({
            chief_route: "route",
          })
          const general = yield* tool.execute({ objective: "Turn on a light", access: "read" }, ctx)
          expect(general.metadata.decision?.request).toBe(request)
          expect(general.metadata.decision?.agent).toBe("generalist")
          const routed = yield* sessions.get(session.id)
          expect(RayaChief.phase(routed.metadata)).toBe("task")
          expect(
            RayaChief.tools(catalog, routed.metadata, { session: session.id, user: user.id })
              .raya_home_assistant_lights_read,
          ).toBeUndefined()
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "route" },
          })
          const foreign = yield* sessions.create()
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                tool.execute(
                  { objective: request, workflow: "home_assistant", access: "read" },
                  { ...ctx, sessionID: foreign.id },
                ),
              ),
            ),
          ).toBe(true)
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: { [RayaChief.requestKey]: "Drifted request" },
          })
          expect(
            Exit.isFailure(
              yield* Effect.exit(tool.execute({ objective: request, workflow: "home_assistant", access: "read" }, ctx)),
            ),
          ).toBe(true)
          yield* sessions.setMetadata({ sessionID: session.id, metadata: { [RayaChief.requestKey]: request } })
          yield* tool.execute({ objective: request, workflow: "home_assistant", access: "read" }, ctx)
          const selected = yield* sessions.get(session.id)
          expect(HomeAssistant.selected(selected.metadata, { session: session.id, user: user.id })).toBe(true)
          expect(
            Exit.isFailure(
              yield* Effect.exit(tool.execute({ objective: request, workflow: "home_assistant", access: "read" }, ctx)),
            ),
          ).toBe(true)
          const latest = yield* sessions.updateMessage({
            ...user,
            id: MessageID.ascending(),
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: latest.id,
            type: "text",
            text: request,
          })
          expect(RayaChief.tools(catalog, selected.metadata, { session: session.id, user: latest.id })).toEqual({
            chief_route: "route",
          })
          expect(
            Exit.isFailure(
              yield* Effect.exit(tool.execute({ objective: request, workflow: "home_assistant", access: "read" }, ctx)),
            ),
          ).toBe(true)
          const agents = yield* Agent.Service
          const voice = yield* agents.get("voice")
          expect(voice?.prompt).toContain("Handle the user's request yourself")
          expect(voice?.prompt).not.toContain(HomeAssistant.auto)
        }),
      { config: { ...cfg, agent: { generalist: { model: "local/fixture" } } } },
    ),
  { timeout: 30000 },
)

it.live(
  "Auto preserves configured device denial",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const agent = yield* agents.get("auto")
          expect(agent).toBeDefined()
          for (const name of [
            "raya_home_assistant_lights_read",
            "raya_home_assistant_lights_set",
            "raya_home_assistant_lights_mode",
          ]) {
            expect(Permission.evaluate(name, "*", agent!.permission).action).toBe("deny")
          }
        }),
      {
        config: {
          ...cfg,
          permission: {
            raya_home_assistant_lights_read: "deny",
            raya_home_assistant_lights_set: "deny",
            raya_home_assistant_lights_mode: "deny",
          },
        },
      },
    ),
  { timeout: 30000 },
)

it.live(
  "Auto keeps global device allow at ask",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const agent = yield* agents.get("auto")
          expect(agent).toBeDefined()
          for (const name of [
            "raya_home_assistant_lights_read",
            "raya_home_assistant_lights_set",
            "raya_home_assistant_lights_mode",
          ]) {
            expect(Permission.evaluate(name, "*", agent!.permission).action).toBe("ask")
          }
        }),
      { config: { ...cfg, permission: { "*": "allow" } } },
    ),
  { timeout: 30000 },
)
