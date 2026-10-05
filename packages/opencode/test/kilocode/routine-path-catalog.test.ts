import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { visible } from "@/kilocode/tool/path-catalog"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { ProviderTest } from "../fake/provider"
import { requireInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node,
      SessionProcessor.node,
      Permission.node,
      Agent.node,
      Session.node,
      Plugin.node,
      RuntimeFlags.node,
      Config.node,
      MCP.node,
      Truncate.node,
      Database.node,
      SessionProjector.node,
    ]),
  ),
)
const model = ProviderTest.model()

test("file discovery retains path subsets without defeating later tool denial or child authority", () => {
  const rules = Permission.fromConfig({ "*": "deny", read: { "*": "deny", "allowed/**": "allow" } })
  expect(visible("read", rules)).toBe(true)
  expect(visible("bash", rules)).toBe(false)
  expect(visible("read", [...rules, { permission: "read", pattern: "allowed/private/**", action: "deny" }])).toBe(true)
  expect(visible("read", [...rules, { permission: "read", pattern: "*", action: "deny" }])).toBe(false)
  expect(visible("read", Permission.fromConfig({ "*": "allow", read: { "private/**": "deny" } }))).toBe(true)
  expect(visible("bash", Permission.fromConfig({ "*": "deny", bash: { "allowed/**": "allow" } }))).toBe(false)
  expect(TaskAuthority.permits("read", "read", "*")).toBe(true)
  expect(TaskAuthority.permits("read", "write", "*")).toBe(false)
})

it.instance(
  "actual Routine catalogs expose the granted file, reject another private path, and preserve message-off",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const ctx = yield* requireInstance
      const file = path.join(tmp.directory, "allowed.txt")
      const outside = path.join(tmp.directory, "private.txt")
      yield* Effect.promise(() => Bun.write(file, "real permitted evidence\n"))
      yield* Effect.promise(() => Bun.write(outside, "must remain unread\n"))
      const relative = path.relative(ctx.worktree, file).replaceAll("\\", "/")
      const rules = Permission.fromConfig({
        "*": "deny",
        read: { "*": "deny", [relative]: "allow" },
        external_directory: {
          "*": "deny",
          [tmp.directory.replaceAll("\\", "/")]: "allow",
          [tmp.directory.replaceAll("\\", "/") + "/**"]: "allow",
        },
      })
      const agents = yield* Agent.Service
      const agent = yield* agents.get("generalist")
      if (!agent) throw new Error("generalist is missing")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: rules, metadata: { rayaRoutine: { version: 1 } } })
      const registry = yield* ToolRegistry.Service
      const catalog = yield* registry.tools({
        agent,
        modelID: model.id,
        providerID: model.providerID,
        permission: rules,
        trustedOnly: true,
      })
      expect(catalog.map((tool) => tool.id)).toContain("read")
      for (const id of ["bash", "background_process", "interactive_terminal", "write", "edit", "apply_patch"])
        expect(catalog.map((tool) => tool.id)).not.toContain(id)
      const message = {
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant" as const,
        modelID: model.id,
        providerID: model.providerID,
        mode: agent.name,
        agent: agent.name,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(message)
      const processor = yield* SessionProcessor.Service
      const handle = yield* processor.create({ assistantMessage: message, sessionID: session.id, model })
      const tools = yield* SessionTools.resolve({
        agent,
        model,
        session,
        processor: handle,
        bypassAgentCheck: false,
        messages: [],
        promptOps: {
          cancel: () => Effect.die(new Error("unused cancellation")),
          resolvePromptParts: () => Effect.die(new Error("unused prompt parsing")),
          prompt: () => Effect.die(new Error("model requests are forbidden in this test")),
        },
        memoryCache: {},
      })
      expect(Object.keys(tools)).toContain("read")
      expect(Object.keys(tools)).not.toContain("bash")
      const execute = tools.read.execute
      if (!execute) throw new Error("actual read executor is missing")
      yield* sessions.get(session.id)
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          execute(
            { filePath: file },
            { toolCallId: "actual-read", messages: [], abortSignal: new AbortController().signal },
          ),
        ),
      )
      expect(JSON.stringify(result)).toContain("real permitted evidence")
      const denied = yield* Effect.promise(() =>
        Promise.resolve(
          execute(
            { filePath: outside },
            { toolCallId: "denied-read", messages: [], abortSignal: new AbortController().signal },
          ),
        ),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("PermissionDeniedError")
      const plugin = yield* Plugin.Service
      const flags = yield* RuntimeFlags.Service
      const user = {
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user" as const,
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
        tools: { read: false },
      }
      const prepared = yield* LLMRequestPrep.prepare({
        user,
        sessionID: session.id,
        model,
        agent,
        permission: rules,
        tools,
        system: [],
        messages: [],
        provider: ProviderTest.info({}, model),
        auth: undefined,
        plugin,
        flags,
        isWorkflow: false,
      })
      expect(Object.keys(prepared.tools)).not.toContain("read")
      const closed = yield* registry.tools({
        agent,
        modelID: model.id,
        providerID: model.providerID,
        permission: [...rules, { permission: "read", pattern: "*", action: "deny" }],
        trustedOnly: true,
      })
      expect(closed.map((tool) => tool.id)).not.toContain("read")
      yield* sessions.remove(session.id)
    }),
  20_000,
)
