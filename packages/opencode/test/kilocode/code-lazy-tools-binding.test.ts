import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
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
import { LLMRequestPrep } from "@/session/llm/request"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { LazyTools } from "@/kilocode/session/lazy-tools"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { z } from "zod"

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
      Config.node,
      MCP.node,
      Truncate.node,
      RuntimeFlags.node,
      Database.node,
      CrossSpawnSpawner.node,
      SessionProjector.node,
      EventV2Bridge.node,
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

for (const name of ["code", "voice"])
  it.live(
    `binds primary ${name} discovery to real completion, permissions and durable authority`,
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
            const agent = yield* agents.get(name)
            if (!agent) throw new Error("Code agent missing")
            const model = yield* provider.getModel(ProviderV2.ID.make("local"), ModelV2.ID.make("fixture"))
            const session = yield* sessions.create()
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: name,
              model: { providerID: model.providerID, modelID: model.id },
              time: { created: Date.now() },
            })
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              parentID: user.id,
              sessionID: session.id,
              role: "assistant",
              mode: name,
              agent: name,
              cost: 0,
              path: { cwd: dir, root: dir },
              providerID: model.providerID,
              modelID: model.id,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            })
            const processor = yield* processors.create({ assistantMessage: assistant, sessionID: session.id, model })
            const resolve = (scope = session, who = agent) =>
              sessions.messages({ sessionID: session.id }).pipe(
                Effect.flatMap((messages) =>
                  SessionTools.resolve({
                    agent: who,
                    model,
                    session: scope,
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
            const prepare = (tools: Awaited<ReturnType<typeof LazyTools.select>>, context = 32768, who = agent) =>
              LLMRequestPrep.prepare({
                user,
                sessionID: session.id,
                model: { ...model, limit: { ...model.limit, context } },
                agent: who,
                system: ["A fixed fixture system. ".repeat(1200)],
                messages: [{ role: "user", content: "Create the requested file." }],
                tools,
                provider: yieldInfo,
                auth: undefined,
                plugin,
                flags,
                isWorkflow: false,
              })
            const yieldInfo = yield* provider.getProvider(model.providerID)
            const options = { toolCallId: "actual-discovery", messages: [], abortSignal: new AbortController().signal }
            const target = path.join(dir, "selected.txt")
            const input = { filePath: target, content: "Genuine selected callback café 日本語 😀" }
            const fresh = yield* resolve()
            const tools = yield* resolve()
            expect(fresh.write).not.toBe(tools.write)
            expect(fresh.write.execute).not.toBe(tools.write.execute)
            yield* Effect.promise(async () =>
              expect(Promise.resolve(tools.write.execute!(input, options))).rejects.toThrow("not active"),
            )
            expect(yield* Effect.promise(async () => Bun.file(target).exists())).toBe(false)
            const first = yield* prepare(tools)
            expect(first.tools.write).toBeUndefined()
            expect(first.tools.discover_tools).toBeDefined()
            const denied = yield* provideTmpdirInstance(
              () =>
                Effect.gen(function* () {
                  const current = yield* agents.get(name)
                  if (!current) throw new Error("Code agent missing")
                  return yield* prepare(yield* resolve(session, current), 32768, current)
                }),
              { config: { ...cfg, permission: { edit: "deny" } } },
            )
            expect(denied.tools.write).toBeUndefined()
            expect(denied.tools.edit).toBeUndefined()

            expect(
              Object.keys(
                (yield* LLMRequestPrep.prepare({
                  user,
                  sessionID: session.id,
                  model,
                  agent,
                  system: [],
                  messages: [],
                  tools,
                  permission: Permission.fromConfig({ "*": "deny" }),
                  provider: yieldInfo,
                  auth: undefined,
                  plugin,
                  flags,
                  isWorkflow: false,
                })).tools,
              ),
            ).toEqual([])
            yield* Effect.promise(async () =>
              expect(first.tools.discover_tools.execute!({ select: ["nonexistent"] }, options)).rejects.toThrow(
                "unavailable",
              ),
            )
            for (const id of ["constructor", "toString", "__proto__"])
              yield* Effect.promise(async () =>
                expect(first.tools.discover_tools.execute!({ select: [id] }, options)).rejects.toThrow("unavailable"),
              )
            const disabled = Permission.disabled(Object.keys(tools), agent.permission)
            const available = Object.keys(tools)
              .filter((id) => !disabled.has(id))
              .sort()
            const ids: string[] = []
            for (let offset = 0; offset < Object.keys(tools).length; offset += 16) {
              const page = z
                .object({ output: z.string() })
                .parse(
                  yield* Effect.promise(async () =>
                    first.tools.discover_tools.execute!({ offset }, { ...options, toolCallId: `page-${offset}` }),
                  ),
                )
              const body = z
                .object({ total: z.number(), tools: z.array(z.object({ id: z.string() })) })
                .parse(JSON.parse(page.output))
              expect(body.tools.length).toBeLessThanOrEqual(16)
              expect(body.total).toBe(available.length)
              ids.push(...body.tools.map((item) => item.id))
            }
            expect(ids).toEqual(available)
            const value = { select: ["write", "discover_capabilities"] }
            const result = z
              .object({ title: z.string(), output: z.string(), metadata: z.record(z.string(), z.unknown()) })
              .parse(
                yield* Effect.promise(async () => Promise.resolve(first.tools.discover_tools.execute!(value, options))),
              )
            const part = yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: assistant.id,
              type: "tool",
              tool: "discover_tools",
              callID: options.toolCallId,
              state: { status: "running", input: value, time: { start: Date.now() } },
            })
            const pending = yield* prepare(yield* resolve())
            expect(pending.tools.write).toBeUndefined()
            yield* sessions.updatePart({
              ...part,
              state: {
                status: "completed",
                input: value,
                title: result.title,
                output: result.output,
                metadata: result.metadata,
                time: { start: Date.now(), end: Date.now() },
              },
            })
            for (const state of [
              {
                status: "completed" as const,
                input: { select: ["task"] },
                title: result.title,
                output: result.output,
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
              {
                status: "completed" as const,
                input: value,
                title: result.title,
                output: result.output + "tampered",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
              {
                status: "error" as const,
                input: value,
                error: "Actual unsuccessful call",
                time: { start: Date.now(), end: Date.now() },
              },
            ]) {
              yield* sessions.updatePart({ ...part, state })
              expect((yield* prepare(yield* resolve())).tools.write).toBeUndefined()
            }
            yield* sessions.updatePart({
              ...part,
              callID: "forged-completed-call",
              state: {
                status: "completed",
                input: value,
                title: result.title,
                output: result.output,
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            })
            expect((yield* prepare(yield* resolve())).tools.write).toBeUndefined()
            yield* sessions.updatePart({
              ...part,
              state: {
                status: "completed",
                input: value,
                title: result.title,
                output: result.output,
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            })
            const isolated = yield* provideTmpdirInstance(
              () => resolve().pipe(Effect.flatMap((tools) => prepare(tools))),
              { config: cfg },
            )
            expect(isolated.tools.write).toBeUndefined()
            const active = yield* prepare(yield* resolve())
            expect(Object.keys(active.tools).sort()).toEqual(["discover_capabilities", "discover_tools", "write"])
            yield* Effect.promise(async () =>
              Promise.resolve(active.tools.write.execute!(input, { ...options, toolCallId: "actual-write" })),
            )
            expect(yield* Effect.promise(async () => Bun.file(target).text())).toBe(input.content)
            const discovery = z
              .object({ output: z.string() })
              .parse(
                yield* Effect.promise(async () =>
                  Promise.resolve(
                    active.tools.discover_capabilities.execute!(
                      { query: "files", limit: 10 },
                      { ...options, toolCallId: "catalog" },
                    ),
                  ),
                ),
              )
            expect(JSON.parse(discovery.output).bound).toBe(true)
            const capabilities = JSON.parse(discovery.output).capabilities
            expect(capabilities.find((item: { id: string }) => item.id === "files.write").tools).toEqual(["write"])
            expect(capabilities.find((item: { id: string }) => item.id === "files.read").tools).toEqual([])
            yield* sessions.setPermission({
              sessionID: session.id,
              permission: Permission.fromConfig({ edit: "deny" }),
            })
            yield* Effect.promise(async () =>
              expect(active.tools.write.execute!({ ...input, content: "must not write" }, options)).rejects.toThrow(
                "denied",
              ),
            )
            expect(yield* Effect.promise(() => Bun.file(target).text())).toBe(input.content)
            const filtered = z
              .object({ output: z.string() })
              .parse(
                yield* Effect.promise(async () =>
                  active.tools.discover_tools.execute!({ query: "write" }, { ...options, toolCallId: "filtered-page" }),
                ),
              )
            expect(JSON.parse(filtered.output).tools.map((item: { id: string }) => item.id)).not.toContain("write")
            yield* sessions.setPermission({ sessionID: session.id, permission: [] })
            const id = name === "voice" ? "edit" : "task"
            const abort = new AbortController()
            const cancelled = z
              .object({ title: z.string(), output: z.string(), metadata: z.record(z.string(), z.unknown()) })
              .parse(
                yield* Effect.promise(async () =>
                  active.tools.discover_tools.execute!(
                    { select: [id] },
                    { ...options, toolCallId: "cancelled-discovery", abortSignal: abort.signal },
                  ),
                ),
              )
            abort.abort()
            yield* sessions.updatePart({
              ...part,
              id: PartID.ascending(),
              callID: "cancelled-discovery",
              state: {
                status: "completed",
                input: { select: [id] },
                title: cancelled.title,
                output: cancelled.output,
                metadata: cancelled.metadata,
                time: { start: Date.now(), end: Date.now() },
              },
            })
            const after = yield* prepare(yield* resolve())
            expect(after.tools[id]).toBeUndefined()
            expect(after.tools.write).toBeDefined()
            const high = yield* prepare(yield* resolve(), 200000)
            expect(high.tools.discover_tools).toBeUndefined()
            expect(high.tools.write).toBeDefined()
            const bound = z
              .object({ output: z.string() })
              .parse(
                yield* Effect.promise(async () =>
                  Promise.resolve(
                    high.tools.discover_capabilities.execute!(
                      { query: "files", limit: 10 },
                      { ...options, toolCallId: "catalog-full" },
                    ),
                  ),
                ),
              )
            expect(JSON.parse(bound.output).bound).toBe(true)
            expect(
              JSON.parse(bound.output).capabilities.find((item: { id: string }) => item.id === "files.read").tools,
            ).toEqual(["read"])
            yield* sessions.updateMessage({ ...user, tools: { write: false } })
            yield* Effect.promise(async () =>
              expect(high.tools.write.execute!(input, options)).rejects.toThrow("denied"),
            )
            yield* sessions.setMetadata({ sessionID: session.id, metadata: TaskAuthority.save({}, "read") })
            const scoped = yield* sessions.get(session.id)
            const readonly = yield* prepare(yield* resolve(scoped))
            expect(readonly.tools.write).toBeUndefined()
            expect(readonly.tools.edit).toBeUndefined()
            expect(readonly.tools.bash).toBeUndefined()
            expect(readonly.tools.read).toBeDefined()
            yield* sessions.setMetadata({ sessionID: session.id, metadata: {} })
            const newer = yield* sessions.updateMessage({
              ...user,
              id: MessageID.ascending(),
              time: { created: Date.now() },
            })
            expect(newer.id).not.toBe(user.id)
            yield* Effect.promise(async () =>
              expect(Promise.resolve(high.tools.write.execute!(input, options))).rejects.toThrow("expired"),
            )
          }),
        { config: cfg },
      ),
    60000,
  )
