import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { expect } from "bun:test"
import { Effect, Exit, Layer, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Command } from "../../src/command"
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
import * as TaskWorker from "../../src/kilocode/session/task-worker"
import { make as voice, VoiceError } from "../../src/kilocode/voice/openai"
import { RayaGoal } from "../../src/kilocode/goal"
import * as GoalCharges from "../../src/kilocode/goal/charges"
import { pricing } from "../../src/kilocode/voice/live-protocol"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { KiloSessions } from "../../src/kilo-sessions/kilo-sessions"
import { Storage } from "../../src/storage/storage"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { provideTmpdirServer } from "../fixture/fixture"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

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
  TaskWorker.node,
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

const it = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, Storage.node]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [KiloSessions.node, KiloSessions.testLayer],
  ]),
)

it.live(
  "a verified completed goal permits fresh original-parent voice work while the old binding stays closed",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const workers = yield* TaskWorker.Service
        const scope = yield* Scope.Scope
        const parent = yield* sessions.create({ title: "Completed goal voice recovery" })
        const goals = RayaGoal.make({ storage, sessions })
        const charges = yield* GoalCharges.make({ storage, sessions })
        yield* goals.create(parent.id, "Verify the command", undefined, undefined, undefined, undefined, {
          chargeCosts: [{ currency: "USD", limit: 2, reservation: 1 }],
        })
        const error = (err: Error) => new VoiceError({ code: "conflict", message: err.message })
        const canonical = yield* voice({
          storage,
          database,
          sessions,
          prompts,
          workers,
          admissions: (id, token) =>
            charges.claim(id, "USD", token).pipe(
              Effect.map((lease) => ({
                amount: lease.amount,
                dispatch: lease.dispatch.pipe(Effect.mapError(error)),
                finish: lease.finish.pipe(Effect.mapError(error)),
                release: lease.release.pipe(Effect.orDie),
              })),
              Effect.mapError(error),
              Effect.provideService(Scope.Scope, scope),
            ),
          completions: (id, token) => charges.complete(id, "USD", token).pipe(Effect.mapError(error)),
          charges: (input) => {
            const price = pricing({ id: input.id, model: "gpt-live-1", seconds: input.seconds })
            return goals
              .charged(input.sessionID, {
                id: input.id,
                kind: "gpt-live",
                provider: "OpenAI",
                service: "GPT-Live 1",
                source: price.source,
                origin: { sessionID: input.sessionID, callID: input.callID },
                at: input.at,
                quantity: price.quantity,
                unit: price.unit,
                coverage: "recorded",
                amount: price.amount,
                currency: price.currency,
              })
              .pipe(Effect.asVoid, Effect.mapError(error))
          },
        })
        const secret = "a".repeat(64)
        const initial = { parentSessionID: parent.id, requestID: "goal_voice_old", model: "gpt-live-1" as const }
        const allowance = yield* canonical.reserve(initial, secret, dir)
        expect(allowance.amount).toBe(1)
        const old = yield* canonical.start({ ...initial, providerCallID: "provider_goal_old" }, secret, dir)
        yield* canonical.close(old.id, old.generation, secret, dir)
        // This is controlled duration evidence through the real goal ledger, not a paid provider call.
        yield* canonical.duration(
          old.id,
          {
            generation: old.generation,
            receipt: { id: "goal_voice_final", model: "gpt-live-1", seconds: 0.5 },
          },
          secret,
          dir,
        )
        yield* llm.push(
          reply().tool("bash", { command: "echo verified", description: "Verify the controlled command" }),
          reply().text("The verification command passed.").stop(),
        )
        yield* prompts.prompt({
          sessionID: parent.id,
          agent: "code",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          parts: [{ type: "text", text: "Run the verification command." }],
        })
        const history = yield* sessions.messages({ sessionID: parent.id })
        const matches = history
          .flatMap((row) => row.parts)
          .filter(
            (part) => part.type === "tool" && part.tool === "bash" && part.state.input.command === "echo verified",
          )
        expect(matches).toHaveLength(1)
        const tool = matches[0]
        if (!tool || tool.type !== "tool" || tool.state.status !== "completed")
          return yield* Effect.die("Actual verification tool did not complete")
        expect(tool.state.metadata.exit).toBe(0)
        const completed = yield* goals.update(parent.id, {
          status: "complete",
          summary: "The actual verification command passed.",
          audit: {
            requirements: [
              {
                requirement: "The command succeeds",
                passed: true,
                evidence: [
                  {
                    callID: tool.callID,
                    messageID: tool.messageID,
                    partID: tool.id,
                    summary: "The persisted bash tool completed with exit code 0.",
                  },
                ],
              },
            ],
          },
        })
        expect(completed.status).toBe("complete")
        expect(completed.charges).toHaveLength(1)
        const fresh = { parentSessionID: parent.id, requestID: "goal_voice_fresh", model: "gpt-live-1" as const }
        const reservation = yield* canonical.reserve(fresh, secret, dir)
        // The completed goal's budget is no longer an admission policy for new ordinary work.
        expect(reservation.amount).toBeUndefined()
        const binding = yield* canonical.start({ ...fresh, providerCallID: "provider_goal_fresh" }, secret, dir)
        yield* llm.push(reply().text("Fresh voice work completed after the goal.").stop())
        const input = {
          generation: binding.generation,
          context: {
            version: 1 as const,
            delegation: "delegation_goal_fresh",
            offset: 900,
            fragments: [
              {
                id: "caption_goal_fresh",
                speaker: "user" as const,
                text: "Please summarize what we verified.",
                start: 0,
                end: 900,
                sequence: 1,
              },
            ],
            incomplete: true as const,
            omitted: false,
          },
        }
        const admitted = yield* canonical.delegate(binding.id, input, secret, dir)
        const result = yield* pollWithTimeout(
          canonical
            .get(binding.id, admitted.callID, binding.generation, secret, dir)
            .pipe(Effect.map((call) => (["accepted", "running"].includes(call.status) ? undefined : call))),
          "Fresh work did not settle after goal completion",
          "20 seconds",
        )
        expect(result.status).toBe("completed")
        expect(result.parentSessionID).toBe(parent.id)
        expect(result.result?.text).toBe("Fresh voice work completed after the goal.")
        const rows = yield* sessions.messages({ sessionID: parent.id })
        const assistant = rows.find((row) => row.info.id === result.result?.assistantMessageID)
        expect(assistant?.info.role === "assistant" && assistant.info.parentID).toBe(result.messageID)
        expect((yield* goals.get(parent.id))?.status).toBe("complete")
        expect((yield* goals.get(parent.id))?.charges).toEqual(completed.charges)
        expect(yield* canonical.delegate(binding.id, input, secret, dir)).toEqual(result)
        expect(
          Exit.isFailure(
            yield* canonical
              .delegate(
                old.id,
                {
                  ...input,
                  generation: old.generation,
                  context: { ...input.context, delegation: "delegation_old_closed" },
                },
                secret,
                dir,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* llm.calls).toBe(3)
        yield* canonical.close(binding.id, binding.generation, secret, dir)
      }),
      {
        git: true,
        config: (url) => ({
          default_agent: "code",
          permission: { "*": "allow" },
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
              options: { apiKey: "test-key", baseURL: url },
            },
          },
        }),
      },
    ),
  60_000,
)
