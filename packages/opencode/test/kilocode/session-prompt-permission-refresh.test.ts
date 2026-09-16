import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import fs, { rename, rm, symlink } from "fs/promises"
import os from "os"
import { Database } from "@opencode-ai/core/database/database"
import path from "path"
import { pathToFileURL } from "url"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Env } from "../../src/env"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider/provider"
import { Question } from "../../src/question"
import { RepositoryCache } from "@opencode-ai/core/repository-cache"
import { SessionCompaction } from "../../src/session/compaction"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SystemPrompt } from "../../src/session/system"
import { SessionSummary } from "../../src/session/summary"
import { Todo } from "../../src/session/todo"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { KiloHeadless } from "../../src/kilocode/permission/headless"
import { KiloSessionPrompt } from "../../src/kilocode/session/prompt"
import { KiloReadObject } from "../../src/kilocode/tool/read-object"
import { KiloSessions } from "../../src/kilo-sessions/kilo-sessions"
import { Storage } from "../../src/storage/storage"
import { RayaTask } from "../../src/kilocode/task"
import { RayaTaskOrganization } from "../../src/kilocode/task/organization"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const waitFor = <A, E, R>(label: string, run: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    const end = Date.now() + 5_000
    while (Date.now() < end) {
      const result = yield* run
      if (result !== undefined) return result
      yield* Effect.sleep(20)
    }
    throw new Error(`timed out waiting for ${label}`)
  })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in permission refresh tests"),
    authenticate: () => Effect.die("unexpected MCP auth in permission refresh tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in permission refresh tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

// One compiled graph, mirroring test/session/prompt.test.ts. Effect v4 does
// not memoize nested layers, so per-service AppNodeBuilder.build calls each stood up their own
// Database and sessions written by the test were invisible to the prompt loop.
const memoryNode = LayerNode.make({ service: MemoryService.Service, layer: MemoryService.layer, deps: [] })
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  memoryNode,
  testLLMServerNode,
])

function makeHttp() {
  return LayerNode.compile(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [KiloSessions.node, KiloSessions.testLayer],
  ])
}
const it = testEffect(makeHttp())
const routineIt = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, Storage.node]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [KiloSessions.node, KiloSessions.testLayer],
  ]),
)
const symlinkIt = process.platform === "win32" ? it.live.skip : it.live

it.live("recognizes Windows named-pipe paths before filesystem inspection", () =>
  Effect.sync(() => {
    expect(KiloReadObject.namedPipe("\\\\.\\pipe\\secret")).toBe(true)
    expect(KiloReadObject.namedPipe("\\\\server\\pipe\\secret")).toBe(true)
    expect(KiloReadObject.namedPipe("C:\\project\\secret.txt")).toBe(false)
  }),
)

const cfg = {
  // Exercise direct file permissions without depending on the default routing agent.
  default_agent: "code",
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

routineIt.live(
  "main chat clarifies and reviews complete Routine and organization assignments",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const questions = yield* Question.Service
        const permissions = yield* Permission.Service
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const organizations = RayaTaskOrganization.make(database, tasks, storage)
        const baseline = {
          tasks: (yield* tasks.list()).length,
          organizations: (yield* organizations.list()).items.length,
        }
        const access = [
          { permission: "*", pattern: "*", action: "allow" as const },
          { permission: "schedule_task", pattern: "*", action: "ask" as const },
        ]
        const routine = {
          name: "Friday Books",
          role: "Accountant",
          objective: "Review the weekly accounts and report discrepancies",
          output: {
            destination: "conversation" as const,
            description: "Weekly accounting review",
            criteria: [
              {
                id: "variance",
                description: "List material discrepancies",
                verification: "Cite each affected account and amount",
              },
            ],
          },
          when: "every Friday at 5pm",
          timezone: "America/Toronto",
          capabilities: ["money"],
          access: "brief" as const,
          tools: ["read"],
          runNow: false,
        }
        const chat = yield* sessions.create({ title: "Friday accounting routine", permission: access })

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "Create an agent to review my accounting every Friday" }],
        })
        yield* llm.push(
          reply().tool("ask_options", {
            questions: [
              {
                prompt: "Which timezone should Friday at 5pm use?",
                options: [
                  { id: "toronto", label: "Toronto" },
                  { id: "utc", label: "UTC" },
                ],
              },
            ],
          }),
          reply().tool("schedule_task", routine),
          reply().text("Friday Books is ready. Its reports will appear in Routines.").stop(),
        )

        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkScoped)
        const timezone = yield* pollWithTimeout(
          questions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
          "Routine clarification was never surfaced",
          "15 seconds",
        )
        yield* questions.reply({ requestID: timezone.id, answers: [["raya-option:toronto"]] })
        const review = yield* pollWithTimeout(
          permissions
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.sessionID === chat.id && item.permission === "schedule_task"),
              ),
            ),
          "Routine review was never surfaced",
          "15 seconds",
        )
        expect(review.patterns).toEqual(["access:brief", "capability:money", "tool:read"])
        expect(review.metadata).toMatchObject({
          name: routine.name,
          role: routine.role,
          objective: routine.objective,
          output: routine.output,
          access: routine.access,
          capabilities: routine.capabilities,
          tools: routine.tools,
          runNow: routine.runNow,
          schedule: { kind: "cron", expr: "0 17 * * 5", tz: "America/Toronto" },
        })
        yield* permissions.reply({ requestID: review.id, reply: "once" })
        const firstResult = yield* awaitWithTimeout(Fiber.join(first), "Routine chat did not finish", "20 seconds")
        expect(
          firstResult.parts.some((part) => part.type === "text" && part.text.includes("Friday Books is ready")),
        ).toBe(true)
        const firstMessages = yield* MessageV2.filterCompactedEffect(chat.id)
        const firstTools = firstMessages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
        expect(firstTools.map((part) => part.tool)).toEqual(["ask_options", "schedule_task"])
        const scheduled = firstTools.find((part) => part.tool === "schedule_task")
        if (scheduled?.state.status !== "completed")
          throw new Error(scheduled?.state.status === "error" ? scheduled.state.error : "The Routine was not created.")
        const identity = yield* Schema.decodeUnknownEffect(Schema.Struct({ agentID: Schema.String }))(
          scheduled.state.metadata,
        ).pipe(Effect.orDie)
        const afterRoutine = yield* tasks.list()
        expect(afterRoutine).toHaveLength(baseline.tasks + 1)
        expect(afterRoutine.find((item) => item.id === identity.agentID)).toMatchObject({
          name: routine.name,
          role: routine.role,
          objective: routine.objective,
          access: routine.access,
          capabilities: routine.capabilities,
          tools: routine.tools,
          schedule: { kind: "cron", expr: "0 17 * * 5", tz: "America/Toronto" },
          output: routine.output,
        })

        const company = {
          name: "Website Builders",
          purpose: "Design and build reviewed websites for approved clients",
          workers: [
            {
              kind: "new" as const,
              key: "design",
              name: "Design Lead",
              role: "Designer",
              objective: "Design each approved client website",
              output: {
                destination: "conversation" as const,
                description: "Reviewed website design",
                criteria: [
                  {
                    id: "design",
                    description: "Present the complete design",
                    verification: "Attach visual evidence",
                  },
                ],
              },
              capabilities: [] as string[],
              access: "brief" as const,
              tools: ["read"],
              when: "only when I ask",
              canCreateWorkers: false,
              delegatesTo: ["build"],
            },
            {
              kind: "new" as const,
              key: "build",
              name: "Frontend Builder",
              role: "Coder",
              objective: "Implement the approved design",
              output: {
                destination: "conversation" as const,
                description: "Verified website implementation",
                criteria: [
                  {
                    id: "build",
                    description: "Deliver the working site",
                    verification: "Report the passing checks",
                  },
                ],
              },
              capabilities: [] as string[],
              access: "full" as const,
              tools: ["read", "write"],
              when: "only when I ask",
              canCreateWorkers: false,
              supervisorKey: "design",
              delegatesTo: [] as string[],
            },
          ],
        }
        const organization = yield* sessions.create({ title: "Website organization", permission: access })
        yield* prompt.prompt({
          sessionID: organization.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "Create a company of agents that makes websites" }],
        })
        yield* llm.push(
          reply().tool("ask_options", {
            questions: [
              {
                prompt: "How should work move through this organization?",
                options: [
                  { id: "design-build", label: "Design, then build" },
                  { id: "independent", label: "Work independently" },
                ],
              },
            ],
          }),
          reply().tool("create_organization", company),
          reply().text("Website Builders is ready. You can open it in Routines.").stop(),
        )

        const second = yield* prompt.loop({ sessionID: organization.id }).pipe(Effect.forkScoped)
        const flow = yield* pollWithTimeout(
          questions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === organization.id))),
          "Organization clarification was never surfaced",
          "15 seconds",
        )
        yield* questions.reply({ requestID: flow.id, answers: [["raya-option:design-build"]] })
        const approval = yield* pollWithTimeout(
          permissions
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.sessionID === organization.id && item.permission === "schedule_task"),
              ),
            ),
          "Organization review was never surfaced",
          "15 seconds",
        )
        expect(approval.patterns).toEqual(["access:brief", "access:full", "tool:read", "tool:write"])
        expect(approval.metadata).toMatchObject(company)
        yield* permissions.reply({ requestID: approval.id, reply: "once" })
        const secondResult = yield* awaitWithTimeout(
          Fiber.join(second),
          "Organization chat did not finish",
          "20 seconds",
        )
        expect(
          secondResult.parts.some((part) => part.type === "text" && part.text.includes("Website Builders is ready")),
        ).toBe(true)
        const secondMessages = yield* MessageV2.filterCompactedEffect(organization.id)
        const secondTools = secondMessages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
        expect(secondTools.map((part) => part.tool)).toEqual(["ask_options", "create_organization"])
        const created = secondTools.find((part) => part.tool === "create_organization")
        if (created?.state.status !== "completed")
          throw new Error(created?.state.status === "error" ? created.state.error : "The organization was not created.")
        const target = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ organizationID: Schema.String, agentIDs: Schema.Array(Schema.String) }),
        )(created.state.metadata).pipe(Effect.orDie)
        const saved = yield* tasks.list()
        expect(saved).toHaveLength(baseline.tasks + 3)
        const workers = target.agentIDs.map((id) => saved.find((item) => item.id === id))
        expect(workers.map((item) => ({ name: item?.name, access: item?.access, tools: item?.tools }))).toEqual([
          { name: "Design Lead", access: "brief", tools: ["read"] },
          { name: "Frontend Builder", access: "full", tools: ["read", "write"] },
        ])
        const roster = yield* organizations.list()
        expect(roster.items).toHaveLength(baseline.organizations + 1)
        expect(roster.items.find((item) => item.id === target.organizationID)).toMatchObject({
          name: company.name,
          purpose: company.purpose,
          revision: 1,
          members: [
            { agentID: workers[0]?.id, role: "Designer", position: 0 },
            { agentID: workers[1]?.id, role: "Coder", position: 1, supervisorID: workers[0]?.id },
          ],
          delegations: [{ senderID: workers[0]?.id, recipientID: workers[1]?.id, position: 0 }],
        })
        expect(firstTools.every((part) => part.state.status === "completed")).toBe(true)
        expect(secondTools.every((part) => part.state.status === "completed")).toBe(true)
        expect(yield* llm.calls).toBe(6)
      }),
      { git: true, config: providerCfg },
    ),
  60_000,
)

it.live(
  "blocks @file content denied by .kilocodeignore",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const sentinel = "KILO_12133_MENTION_SENTINEL"
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(dir, "my_file.txt"), sentinel),
            Bun.write(path.join(dir, ".kilocodeignore"), "my_file.txt\n"),
          ]),
        )

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const session = yield* sessions.create({})
        const parts = yield* prompt.resolvePromptParts("Please list the contents of @my_file.txt")
        const message = yield* prompt.prompt({ sessionID: session.id, noReply: true, parts })
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(parts.some((part) => part.type === "file" && part.filename === "my_file.txt")).toBe(true)
        expect(text).not.toContain(sentinel)
        expect(text).toContain("prevents you from using this specific tool call")
        expect(message.parts.some((part) => part.type === "file")).toBe(false)
        expect(yield* permission.list()).toEqual([])
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

it.live(
  "fails closed when an @file path changes while permission is pending",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const sentinel = "KILO_12133_ASK_SENTINEL"
        const denied = "KILO_12133_REPLACEMENT_SENTINEL"
        const file = path.join(dir, "ask.txt")
        const replacement = path.join(dir, "replacement.txt")
        yield* Effect.promise(() => Promise.all([Bun.write(file, sentinel), Bun.write(replacement, denied)]))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const agents = yield* AgentSvc.Service
        const agent = yield* agents.defaultInfo()
        const session = yield* sessions.create({})
        expect(Permission.evaluate("read", "ask.txt", agent.permission).action).toBe("ask")
        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            noReply: true,
            parts: yield* prompt.resolvePromptParts("Read @ask.txt"),
          })
          .pipe(Effect.forkScoped)
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.find((request) => request.sessionID === session.id && request.permission === "read")
          }),
          "file mention read permission was never requested",
          "15 seconds",
        )

        expect(pending.patterns).toEqual(["ask.txt"])
        yield* Effect.promise(() => rename(replacement, file))
        yield* permission.reply({ requestID: pending.id, reply: "once" })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const text = exit.value.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          expect(text).not.toContain(sentinel)
          expect(text).not.toContain(denied)
          expect(text).toContain("changed after authorization")
        }
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: { read: { "*": "allow", "ask.txt": "ask" } },
        }),
      },
    ),
  30_000,
)

it.live(
  "adds @file content after read permission approval",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const sentinel = "KILO_12133_APPROVED_SENTINEL"
        const file = path.join(dir, "approved.txt")
        yield* Effect.promise(() => Bun.write(file, sentinel))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const session = yield* sessions.create({})
        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            noReply: true,
            parts: yield* prompt.resolvePromptParts("Read @approved.txt"),
          })
          .pipe(Effect.forkScoped)
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.find((request) => request.sessionID === session.id && request.permission === "read")
          }),
          "approved file read permission was never requested",
          "15 seconds",
        )

        yield* permission.reply({ requestID: pending.id, reply: "once" })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const text = exit.value.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          expect(text).toContain(sentinel)
        }
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: { read: { "*": "allow", "approved.txt": "ask" } },
        }),
      },
    ),
  30_000,
)

it.live(
  "stops a prompt while an attachment read permission is pending",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const sentinel = "KILO_12133_ABORT_SENTINEL"
        const file = path.join(dir, "abort.txt")
        yield* Effect.promise(() => Bun.write(file, sentinel))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const session = yield* sessions.create({})
        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            parts: yield* prompt.resolvePromptParts("Read @abort.txt"),
          })
          .pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.find((request) => request.sessionID === session.id && request.permission === "read")
          }),
          "attachment read permission was never requested",
          "15 seconds",
        )

        yield* prompt.cancel(session.id)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.some((request) => request.sessionID === session.id) ? undefined : true
          }),
          "attachment read permission remained after cancellation",
          "15 seconds",
        )
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(
          messages.flatMap((message) => message.parts).some((part) => "text" in part && part.text.includes(sentinel)),
        ).toBe(false)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* llm.calls).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), permission: { read: "ask" } }),
      },
    ),
  30_000,
)

it.live(
  "stops a legacy command while an attachment read permission is pending",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const sentinel = "KILO_12133_COMMAND_ABORT_SENTINEL"
        const file = path.join(dir, "command.txt")
        yield* Effect.promise(() => Bun.write(file, sentinel))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const session = yield* sessions.create({})
        const fiber = yield* prompt
          .command({
            sessionID: session.id,
            command: "local-review",
            arguments: "",
            parts: [
              {
                type: "file",
                mime: "text/plain",
                filename: "command.txt",
                url: pathToFileURL(file).href,
              },
            ],
          })
          .pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.find((request) => request.sessionID === session.id && request.permission === "read")
          }),
          "legacy command attachment permission was never requested",
          "15 seconds",
        )

        yield* prompt.cancel(session.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect((yield* permission.list()).some((request) => request.sessionID === session.id)).toBe(false)
        const messages = yield* sessions.messages({ sessionID: session.id })
        expect(
          messages.flatMap((message) => message.parts).some((part) => "text" in part && part.text.includes(sentinel)),
        ).toBe(false)
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), permission: { read: "ask" } }),
      },
    ),
  30_000,
)

it.live(
  "fails closed when a direct attachment path changes while permission is pending",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const allowed = "KILO_12133_ALLOWED_BINARY_SENTINEL"
        const denied = "KILO_12133_REPLACEMENT_BINARY_SENTINEL"
        const file = path.join(dir, "binary.bin")
        const replacement = path.join(dir, "replacement.bin")
        yield* Effect.promise(() => Promise.all([Bun.write(file, allowed), Bun.write(replacement, denied)]))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const session = yield* sessions.create({})
        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            noReply: true,
            parts: [
              { type: "text", text: "Read @binary.bin" },
              {
                type: "file",
                mime: "application/octet-stream",
                filename: "binary.bin",
                url: pathToFileURL(file).href,
              },
            ],
          })
          .pipe(Effect.forkScoped)
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.find((request) => request.sessionID === session.id && request.permission === "read")
          }),
          "binary attachment read permission was never requested",
          "15 seconds",
        )

        yield* Effect.promise(() => rename(replacement, file))
        yield* permission.reply({ requestID: pending.id, reply: "once" })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const text = exit.value.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          expect(text).not.toContain(allowed)
          expect(text).not.toContain(denied)
          expect(text).toContain("changed after authorization")
          expect(exit.value.parts.some((part) => part.type === "file")).toBe(false)
        }
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: { read: { "*": "allow", "binary.bin": "ask" } },
        }),
      },
    ),
  30_000,
)

it.live(
  "does not load nearby instructions while expanding a file mention",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const allowed = "KILO_12133_ALLOWED_FILE_SENTINEL"
        const denied = "KILO_12133_DENIED_INSTRUCTION_SENTINEL"
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(path.join(dir, "nested"))
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(dir, "nested", "file.txt"), allowed),
            Bun.write(path.join(dir, "nested", "AGENTS.md"), denied),
            Bun.write(path.join(dir, ".kilocodeignore"), "nested/AGENTS.md\n"),
          ]),
        )

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const message = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: yield* prompt.resolvePromptParts("Read @nested/file.txt"),
        })
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(text).toContain(allowed)
        expect(text).not.toContain(denied)
        expect(text).not.toContain("Instructions from:")
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

it.live(
  "does not inline directory children and blocks denied binary attachments",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const folder = path.join(dir, "folder")
        const binary = path.join(dir, "secret.bin")
        const nested = "KILO_12133_DIRECTORY_SENTINEL"
        const direct = "KILO_12133_BINARY_SENTINEL"
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(folder)
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(folder, "public.txt"), "public content"),
            Bun.write(path.join(folder, "private.txt"), nested),
            Bun.write(binary, direct),
          ]),
        )

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const directory = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: yield* prompt.resolvePromptParts("Read @folder"),
        })
        const file = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            { type: "text", text: "Read @secret.bin" },
            { type: "file", mime: "application/octet-stream", filename: "secret.bin", url: pathToFileURL(binary).href },
          ],
        })
        const text = [...directory.parts, ...file.parts]
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(text).not.toContain(nested)
        expect(text).not.toContain(direct)
        expect(text.match(/prevents you from using this specific tool call/g)).toHaveLength(1)
        expect(file.parts.some((part) => part.type === "file")).toBe(false)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: {
            read: {
              "*": "allow",
              "folder/private.txt": "deny",
              "secret.bin": "deny",
            },
          },
        }),
      },
    ),
  30_000,
)

symlinkIt(
  "checks read rules for both symlink names and targets",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const text = "KILO_12133_SYMLINK_TEXT_SENTINEL"
        const binary = "KILO_12133_SYMLINK_BINARY_SENTINEL"
        const privateText = path.join(dir, "private.txt")
        const publicText = path.join(dir, "public.txt")
        const privateBinary = path.join(dir, "private.bin")
        const publicBinary = path.join(dir, "public.bin")
        yield* Effect.promise(async () => {
          await Promise.all([Bun.write(privateText, text), Bun.write(privateBinary, binary)])
          await Promise.all([symlink("private.txt", publicText), symlink("private.bin", publicBinary)])
        })

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const mention = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: yield* prompt.resolvePromptParts("Read @public.txt"),
        })
        const attachment = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            { type: "text", text: "Read @public.bin" },
            {
              type: "file",
              mime: "application/octet-stream",
              filename: "public.bin",
              url: pathToFileURL(publicBinary).href,
            },
          ],
        })
        const content = [...mention.parts, ...attachment.parts]
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(content).not.toContain(text)
        expect(content).not.toContain(binary)
        expect(content.match(/prevents you from using this specific tool call/g)).toHaveLength(2)
        expect(attachment.parts.some((part) => part.type === "file")).toBe(false)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: {
            read: {
              "*": "allow",
              "private.txt": "deny",
              "private.bin": "deny",
            },
          },
        }),
      },
    ),
  30_000,
)

symlinkIt(
  "does not trust symlink targets outside configured references",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const docs = path.join(dir, "docs")
        const outside = path.join(os.tmpdir(), `kilo-12133-${crypto.randomUUID()}.txt`)
        const sentinel = "KILO_12133_REFERENCE_SYMLINK_SENTINEL"
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(docs)
        yield* Effect.promise(() => Bun.write(outside, sentinel))
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(outside, { force: true })))
        yield* Effect.promise(() => symlink(outside, path.join(docs, "public.txt")))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const message = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            { type: "text", text: "Read @docs/public.txt" },
            {
              type: "file",
              mime: "text/plain",
              filename: "docs/public.txt",
              url: pathToFileURL(path.join(docs, "public.txt")).href,
            },
          ],
        })
        const content = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(content).not.toContain(sentinel)
        expect(content).toContain("prevents you from using this specific tool call")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          reference: { docs: "./docs" },
          permission: { read: "allow", external_directory: "deny" },
        }),
      },
    ),
  30_000,
)

symlinkIt(
  "does not disclose suggestions through an external symlinked parent",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const outside = path.join(os.tmpdir(), `kilo-12133-missing-${crypto.randomUUID()}`)
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(outside)
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(outside, { recursive: true, force: true })))
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(outside, "missing-secret-name.txt"), "secret"),
            symlink(outside, path.join(dir, "link")),
          ]),
        )

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const missing = path.join(dir, "link", "missing-secret")
        const message = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            { type: "text", text: "Read @link/missing-secret" },
            {
              type: "file",
              mime: "text/plain",
              filename: "link/missing-secret",
              url: pathToFileURL(missing).href,
            },
          ],
        })
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(text).not.toContain("missing-secret-name.txt")
        expect(text).toContain("prevents you from using this specific tool call")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: { read: "allow", external_directory: "deny" },
        }),
      },
    ),
  30_000,
)

symlinkIt(
  "does not expand a directory attachment after permission approval",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const folder = path.join(dir, "folder")
        const moved = path.join(dir, "moved")
        const outside = path.join(os.tmpdir(), `kilo-12133-directory-${crypto.randomUUID()}`)
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(folder)
        yield* fs.ensureDir(outside)
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(outside, { recursive: true, force: true })))
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(folder, "allowed-name.txt"), "allowed"),
            Bun.write(path.join(outside, "secret-name.txt"), "secret"),
          ]),
        )

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const session = yield* sessions.create({})
        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            noReply: true,
            parts: yield* prompt.resolvePromptParts("Read @folder"),
          })
          .pipe(Effect.forkScoped)
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.find((request) => request.sessionID === session.id && request.permission === "read")
          }),
          "directory read permission was never requested",
          "15 seconds",
        )

        yield* Effect.promise(async () => {
          await rename(folder, moved)
          await symlink(outside, folder)
        })
        yield* permission.reply({ requestID: pending.id, reply: "once" })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const text = exit.value.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          expect(text).not.toContain("allowed-name.txt")
          expect(text).not.toContain("secret-name.txt")
          expect(text).toContain("Directory attachments cannot be expanded")
        }
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), permission: { read: "ask" } }),
      },
    ),
  30_000,
)

symlinkIt(
  "does not expand a directory attachment swapped to a different workspace directory",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const folder = path.join(dir, "folder")
        const moved = path.join(dir, "moved")
        const secret = path.join(dir, "secret-dir")
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(folder)
        yield* fs.ensureDir(secret)
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(path.join(folder, "allowed-name.txt"), "allowed"),
            Bun.write(path.join(secret, "secret-name.txt"), "secret"),
          ]),
        )

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const session = yield* sessions.create({})
        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            noReply: true,
            parts: yield* prompt.resolvePromptParts("Read @folder"),
          })
          .pipe(Effect.forkScoped)
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const requests = yield* permission.list()
            return requests.find((request) => request.sessionID === session.id && request.permission === "read")
          }),
          "directory read permission was never requested",
          "15 seconds",
        )

        yield* Effect.promise(async () => {
          await rename(folder, moved)
          await symlink(secret, folder)
        })
        yield* permission.reply({ requestID: pending.id, reply: "once" })
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const text = exit.value.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
          expect(text).not.toContain("allowed-name.txt")
          expect(text).not.toContain("secret-name.txt")
          expect(text).toContain("Directory attachments cannot be expanded")
        }
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), permission: { read: "ask" } }),
      },
    ),
  30_000,
)

it.live(
  "expands a workspace directory attachment instead of denying it",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const folder = path.join(dir, "folder")
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(folder)
        yield* Effect.promise(() =>
          Promise.all([Bun.write(path.join(folder, "a.txt"), "alpha"), Bun.write(path.join(folder, "b.txt"), "beta")]),
        )

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const message = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            { type: "text", text: "Read @folder" },
            {
              type: "file",
              mime: "text/plain",
              filename: "folder",
              url: pathToFileURL(folder).href,
            },
          ],
        })
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(text).toContain("a.txt")
        expect(text).toContain("b.txt")
        expect(text).not.toContain("Directory attachments cannot be expanded")
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), permission: { read: "allow" } }),
      },
    ),
  30_000,
)

it.live(
  "checks read permission without enumerating missing-file suggestions",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const folder = path.join(dir, "private")
        const fs = yield* FSUtil.Service
        yield* fs.ensureDir(folder)
        yield* Effect.promise(() => Bun.write(path.join(folder, "missing-secret-name.txt"), "secret"))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const missing = path.join(folder, "missing-secret")
        const message = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            { type: "text", text: "Read @private/missing-secret" },
            {
              type: "file",
              mime: "text/plain",
              filename: "private/missing-secret",
              url: pathToFileURL(missing).href,
            },
          ],
        })
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(text).not.toContain("missing-secret-name.txt")
        expect(text).toContain("prevents you from using this specific tool call")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: { read: { "*": "allow", "private/*": "deny" } },
        }),
      },
    ),
  30_000,
)

symlinkIt(
  "rejects a denied FIFO attachment without waiting for a writer",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const fifo = path.join(dir, "secret.pipe")
        const child = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "pipe", windowsHide: true })
        expect(yield* Effect.promise(() => child.exited)).toBe(0)

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const message = yield* prompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            { type: "text", text: "Read @secret.pipe" },
            {
              type: "file",
              mime: "text/plain",
              filename: "secret.pipe",
              url: pathToFileURL(fifo).href,
            },
          ],
        })
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        expect(text).toContain("Not a regular file")
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), permission: { read: "deny" } }),
      },
    ),
  30_000,
)

it.live(
  "global skill shell access can be approved permanently",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const permission = yield* Permission.Service
        const chat = yield* sessions.create({ title: "Global skill permission" })
        const skill = path.join(Global.Path.config, "skills", chat.id)
        const call = { command: "pwd", workdir: skill, description: "Run global skill resource" }

        yield* Effect.promise(() => fs.mkdir(skill, { recursive: true }))
        yield* llm.push(reply().tool("bash", call), reply().text("first complete").stop())

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "run the skill" }],
        })
        const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkScoped)

        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* permission.list()
            return list.find((item) => item.sessionID === chat.id)
          }),
          "global skill permission was never surfaced",
          "10 seconds",
        )
        expect(pending?.permission).toBe("external_directory")
        const always = (pending?.always ?? []) as string[]
        expect(always).toHaveLength(1)
        expect(always[0]?.endsWith(`/skills/${chat.id}/*`)).toBe(true)
        const rules = (pending?.metadata?.rules ?? []) as string[]
        expect(rules).toHaveLength(1)
        expect(rules[0]?.endsWith(`/skills/${chat.id}/*`)).toBe(true)
        expect(pending.metadata).not.toMatchObject({ disableAlways: true, configProtected: true })

        yield* permission.reply({ requestID: pending.id, reply: "always" })
        expect(
          Exit.isSuccess(
            yield* awaitWithTimeout(Fiber.await(first), "first global skill run did not finish", "15 seconds"),
          ),
        ).toBe(true)

        yield* llm.push(reply().tool("bash", call), reply().text("second complete").stop())
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "run the skill again" }],
        })
        const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkScoped)
        expect(
          Exit.isSuccess(
            yield* awaitWithTimeout(Fiber.await(second), "trusted global skill prompted a second time", "15 seconds"),
          ),
        ).toBe(true)
        expect(yield* permission.list()).toEqual([])
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          permission: { bash: "allow", external_directory: "allow" },
        }),
      },
    ),
  { timeout: 30_000 },
)

it.live("active tool calls use permissions changed after model streaming starts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const config = yield* Config.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const file = path.join(dir, "note.txt")
      const gate = Promise.withResolvers<void>()

      yield* Effect.promise(() => Bun.write(file, "old"))
      yield* llm.push(reply().wait(gate.promise).tool("edit", { filePath: file, oldString: "old", newString: "new" }))

      const chat = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "edit note" }],
      })

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkScoped)
      yield* llm.wait(1)
      yield* config.update({ permission: { edit: { "*": "allow" } } } as Config.Info)
      gate.resolve(undefined)

      yield* waitFor(
        "edit without permission prompt",
        Effect.gen(function* () {
          const pending = yield* permission.list()
          if (pending.length) throw new Error("edit permission was requested after config allowed it")
          const text = yield* Effect.promise(() => Bun.file(file).text())
          if (text === "new") return text
        }),
      )

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        permission: { edit: "ask" },
      }),
    },
  ),
)

const worker = (mode: "subagent" | "all"): AgentSvc.Info => ({
  name: "worker",
  mode,
  permission: Permission.fromConfig({ bash: "ask" }),
  options: {},
})

const bash = (sessionID: Session.Info["id"]) => ({
  sessionID,
  permission: "bash",
  patterns: ["echo 1"],
  always: ["echo 1"],
  metadata: {},
})

// Reproduces #11903: a sync subagent hitting an "ask" rule in a headless run
// used to block forever on a permission prompt no client would ever answer.
it.live("headless run: subagent permission asks fail instead of waiting forever", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      const child = yield* sessions.create({ parentID: root.id, title: "Subagent" })
      KiloHeadless.mark(root.id)

      // mode "all" agents are valid subagents too; the deny must not key off agent mode
      const agent = worker("all")
      const err = yield* awaitWithTimeout(
        KiloSessionPrompt.askPermission({
          permission,
          agents: { get: () => Effect.succeed(agent) },
          sessions,
          agent,
          session: child,
          request: bash(child.id),
        }).pipe(Effect.flip),
        "subagent permission ask queued waiting for a human reply instead of failing",
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      expect(yield* permission.list()).toEqual([])
      expect(yield* KiloHeadless.denies(child.id)).toBe(true)
      expect(yield* KiloHeadless.denies(root.id)).toBe(false)

      KiloHeadless.clear(root.id)
    }),
    { git: true },
  ),
)

it.live("interactive run: subagent permission asks still queue for a human reply", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      const child = yield* sessions.create({ parentID: root.id, title: "Subagent" })

      const agent = worker("subagent")
      const fiber = yield* KiloSessionPrompt.askPermission({
        permission,
        agents: { get: () => Effect.succeed(agent) },
        sessions,
        agent,
        session: child,
        request: bash(child.id),
      }).pipe(Effect.forkScoped)

      const pending = yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* permission.list()
          return list.find((item) => item.sessionID === child.id)
        }),
        "subagent permission ask was never surfaced",
      )
      yield* permission.reply({ requestID: pending.id, reply: "reject" })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
    { git: true },
  ),
)

it.live("headless run: root session permission asks still queue (only subagents fail)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      KiloHeadless.mark(root.id)

      const agent = { ...worker("subagent"), mode: "primary" as const }
      const fiber = yield* KiloSessionPrompt.askPermission({
        permission,
        agents: { get: () => Effect.succeed(agent) },
        sessions,
        agent,
        session: root,
        request: bash(root.id),
      }).pipe(Effect.forkScoped)

      const pending = yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* permission.list()
          return list.find((item) => item.sessionID === root.id)
        }),
        "root permission ask was never surfaced",
      )
      yield* permission.reply({ requestID: pending.id, reply: "reject" })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      KiloHeadless.clear(root.id)
    }),
    { git: true },
  ),
)
