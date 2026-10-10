import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Log } from "@opencode-ai/core/util/log" // kilocode_change
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { usable } from "./overflow" // kilocode_change
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
// kilocode_change start
import { InstanceState } from "@/effect/instance-state"
import { KiloSession } from "@/kilocode/session"
import { KiloLLM } from "@/kilocode/session/llm"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import * as MemoryContext from "@/kilocode/second-brain/context"
import { ToolInputRepair } from "@/kilocode/session/tool-input-repair"
import { KiloToolSchema } from "@/kilocode/session/tool-schema"
import { SessionExport } from "@/kilocode/session-export"
import { getActiveOrg } from "@/kilocode/session-export/eligibility"
import { normalizeUsageForExport, observeFullStreamForExport } from "@/kilocode/session-export/llm"
import { TurnTools } from "@/kilocode/capability/turn-tools"
import { refuse, LocalNativeError } from "@/kilocode/provider/native-policy"
import { lane, headers } from "@/kilocode/provider/inference-lane"
import { Database } from "@opencode-ai/core/database/database"
import { effective as ollamaWindow, structured as ollamaNative } from "@/kilocode/provider/ollama-context" // kilocode_change
import * as OllamaPrompt from "@/kilocode/provider/ollama-prompt"
import { Session } from "./session" // kilocode_change - observed-result contracts read original persisted invocation authority
import { ResultContract } from "@/kilocode/chief/result-contract" // kilocode_change - result selection is bound to the actual saved Chief dispatch
import * as ObservedResult from "@/kilocode/provider/result-contract" // kilocode_change - final entries are rendered from verified completed Read parts
import * as ResultFrame from "@/kilocode/provider/result-frame" // kilocode_change - native result grammar remains private to the original request
// kilocode_change end
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"

const log = Log.create({ service: "llm" }) // kilocode_change

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  final?: boolean // kilocode_change - internal step budget applies only to an authenticated observed-result frame
  preflight?: boolean // kilocode_change - enable proactive threshold compaction for normal session turns
  reportedContextTokens?: number // kilocode_change - provider-reported context size from the last finished turn, source of truth for the output cap
  messageID?: string // kilocode_change - exact assistant publication for observed-result contracts
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
  | Database.Service // kilocode_change - per-request local inference classification
  | Session.Service // kilocode_change - original observed-result contract and completed acquisition
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service // kilocode_change - immutable owning database for lane lookup
    const sessions = yield* Session.Service // kilocode_change - source-reference publication uses actual saved tool parts

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log.clone().tag("providerID", input.model.providerID).tag("modelID", input.model.id) // kilocode_change
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )
      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      input = { ...input, model: ollamaWindow(item.options, input.model) } // kilocode_change - explicit native windows govern preflight and output
      // kilocode_change start - private authority precedes plugin preparation; its actual guide participates in preflight
      const owned = input.messageID
        ? yield* ResultContract.load(sessions, {
            sessionID: SessionID.make(input.sessionID),
            userID: input.user.id,
            messageID: input.messageID,
          })
        : undefined
      const guide = owned?.kind === "directory_entries" ? yield* ObservedResult.guide(sessions, owned) : undefined
      const grammar = yield* ResultFrame.create(sessions, owned)
      const choice =
        grammar && input.final
          ? "none"
          : input.toolChoice === "required" && ResultFrame.selected(grammar)?.length
            ? "auto"
            : input.toolChoice
      // kilocode_change end
      const base = yield* LLMRequestPrep.prepare({
        ...input,
        system: guide ? [...input.system, guide] : input.system, // kilocode_change - bound result grammar is counted against the real context
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // kilocode_change start - compact at the configured threshold before contacting the provider
      const tools = yield* Effect.promise(() => KiloToolSchema.sanitize(base.tools))
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"
      const estimated: ModelMessage[] =
        isOpenaiOauth || isWorkflow
          ? [
              {
                role: "system",
                content: isOpenaiOauth ? String(base.params.options.instructions ?? "") : base.system.join("\n"),
              },
              ...base.messages,
            ]
          : base.messages
      const preflight = input.preflight === true && input.model.limit.context !== 0
      const frame = yield* Effect.promise(() =>
        OllamaPrompt.prepare(
          item.options,
          input.model,
          estimated,
          tools,
          choice,
          base.messageTransformOptions,
          false, // kilocode_change
          grammar, // kilocode_change - measured schema matches the original native POST
        ),
      )
      const cap = KiloLLM.needsEstimate({ model: input.model, configured: base.params.maxOutputTokens })
      const measured = frame?.usage ?? (cap ? KiloSessionOverflow.measure({ messages: estimated, tools }) : undefined)
      const native = ollamaNative(item.options, input.model.api.npm)
      const maxOutputTokens = KiloLLM.capOutputTokens({
        model: input.model,
        messages: frame?.messages ?? estimated,
        tools: frame?.budget ?? tools,
        configured: base.params.maxOutputTokens,
        usage: measured,
        reported: input.reportedContextTokens,
        native,
      })
      const checked = preflight
        ? KiloSessionOverflow.preflight({
            cfg,
            model: input.model,
            usable: usable({ cfg, model: input.model, outputTokenMax: flags.outputTokenMax }),
            messages: frame?.messages ?? estimated,
            tools: frame?.budget ?? tools,
            reported: input.reportedContextTokens,
            output: native ? maxOutputTokens : base.params.maxOutputTokens,
            native,
          })
        : undefined
      const usage = checked?.usage ?? measured
      if (checked?.compact) {
        return yield* Effect.fail(KiloSessionOverflow.error(checked, input.model))
      }
      MemoryContext.prepare({
        originals: input.tools,
        tools,
        messages: estimated,
        context: input.model.limit.input || input.model.limit.context,
        output: input.model.limit.input ? 0 : maxOutputTokens,
        reported: input.reportedContextTokens,
        usage,
        native: native ? { context: input.model.limit.context, output: maxOutputTokens } : undefined,
      })
      const prepared = { ...base, tools, params: { ...base.params, maxOutputTokens } }
      const selected = item.options.localInference === true ? yield* lane(input, database) : "interactive"
      prepared.headers = headers(prepared.headers, selected, item.options.localInference === true)
      // kilocode_change end

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            // kilocode_change - report the current registry so stale tool assumptions are not retried
            return { result: "", error: TurnTools.unavailable(toolName, Object.keys(prepared.tools)) } // kilocode_change
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const instance = yield* InstanceState.context
      // kilocode_change start - capture eligible session export request start
      const isKilo = input.model.api.npm === "@kilocode/kilo-gateway"
      const exporting = SessionExport.enabled
      const org = yield* exporting && isKilo && input.model.isFree === true
        ? Effect.promise(() => getActiveOrg())
        : Effect.succeed({ type: "unknown" as const })
      const started = Date.now()
      const parent = input.parentSessionID ?? KiloSession.resolveParent(input.sessionID)
      const found = KiloSession.resolveRoot(input.sessionID)
      const root = parent ? (found === input.sessionID ? parent : found) : input.sessionID
      const exportable =
        exporting && isKilo && input.model.isFree === true && org.type === "personal" && input.agent.name !== "title"
      if (exportable) {
        SessionExport.beforeRequest({
          input: { model: input.model, org },
          requestMeta: {
            sessionId: input.sessionID,
            rootSessionId: root,
            parentSessionId: parent,
            requestId: input.user.id,
            userMessageId: input.user.id,
            agent: input.agent.name,
            modeId: input.agent.mode,
            workspaceKey: instance.directory,
            agentInfo: SessionExport.agentInfo(input.agent),
          },
          assembled: {
            system: prepared.system,
            messages: prepared.messages,
            tools: prepared.tools,
            permissions: input.permission ?? [],
            toolChoice: choice, // kilocode_change
            params: prepared.params,
          },
        })
      }
      // kilocode_change end

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      // kilocode_change start - raya_change: DeepSeek bypasses the opt-in flag because AI SDK cannot execute DSML
      if (flags.experimentalNativeLlm || LLMNativeRuntime.requiresNative(input.model)) {
        // kilocode_change end
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: choice, // kilocode_change
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          // kilocode_change start
          maxOutputTokens: ProviderTransform.maxOutputTokensForRequest({
            model: input.model,
            options: prepared.params.options,
            maxOutputTokens: prepared.params.maxOutputTokens,
          }),
          // kilocode_change end
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
          frame: grammar, // kilocode_change - separate private authority, never provider configuration
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
            owned, // kilocode_change - neither plugins nor provider options can mint final publication authority
          }
        }
        if (refuse(item.options, LLMNativeRuntime.requiresNative(input.model)))
          // kilocode_change - local DSML requests require native tool execution
          return yield* Effect.fail(new LocalNativeError()) // kilocode_change - local DSML requests cannot silently lose tool execution through SDK fallback
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      const result = streamText({
        onError(error) {
          bridge.fork(
            Effect.logError("stream error", {
              providerID: input.model.providerID,
              modelID: input.model.id,
              "session.id": input.sessionID,
              small: (input.small ?? false).toString(),
              agent: input.agent.name,
              mode: input.agent.mode,
              error,
            }),
          )
        },
        // Copilot returns the authoritative billed amount only in provider-specific response fields.
        includeRawChunks: input.model.providerID.includes("github-copilot"),
        async experimental_repairToolCall(failed) {
          const lower = failed.toolCall.toolName.trim().toLowerCase() // kilocode_change
          // kilocode_change start
          if (lower === "invalid" || !prepared.tools[lower]) return null
          const fixed = ToolInputRepair.complete(failed.toolCall.input)
          if (lower !== failed.toolCall.toolName || fixed) {
            l.info("repairing tool call", {
              tool: failed.toolCall.toolName,
              repaired: lower,
              input: fixed ? "completed-delimiters" : "unchanged",
            })
            return { ...failed.toolCall, toolName: lower, input: fixed ?? failed.toolCall.input }
          }
          // kilocode_change end
          if (input.agent.name === "auto") return null // kilocode_change - preserve the original error instead of inventing delegation or an unavailable invalid-tool call
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        },
        temperature: prepared.params.temperature,
        topP: prepared.params.topP,
        topK: prepared.params.topK,
        providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
        activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
        // kilocode_change start
        tools: prepared.tools,
        toolChoice: choice, // kilocode_change
        maxOutputTokens: ProviderTransform.maxOutputTokensForRequest({
          model: input.model,
          options: prepared.params.options,
          maxOutputTokens: prepared.params.maxOutputTokens,
        }),
        // kilocode_change end
        abortSignal: input.abort,
        ...KiloLLM.timeout({ options: prepared.params.options, fallback: item.options, log: l }), // kilocode_change
        headers: prepared.headers,
        maxRetries: input.retries ?? 0,
        allowSystemInMessages: true, // kilocode_change - system prompts are trusted and intentionally included in messages
        messages: prepared.messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              // kilocode_change start - scope the actual cached model invocation, not a deferred Effect
              async wrapStream({ doStream }) {
                return ResultFrame.run(grammar, () => doStream(), input.abort)
              },
              // kilocode_change end
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(
                    args.params.prompt,
                    input.model,
                    prepared.messageTransformOptions,
                  )
                }
                return args.params
              },
            },
          ],
        }),
        // kilocode_change start - disable AI SDK span recording (ai.* / gen_ai.*)
        experimental_telemetry: { isEnabled: false },
      })
      // kilocode_change end
      // kilocode_change start - capture eligible session export request completion off the stream path
      if (!exportable) return { type: "ai-sdk" as const, result, owned } // kilocode_change - carry the privately checked result requirement
      return {
        type: "ai-sdk" as const,
        owned, // kilocode_change
        result: {
          fullStream: observeFullStreamForExport(result.fullStream, {
            sessionId: input.sessionID,
            rootSessionId: root,
            parentSessionId: parent,
            requestId: input.user.id,
            workspaceKey: instance.directory,
            started,
            retries: input.retries ?? 0,
          }),
        },
      }
      // kilocode_change end
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            // kilocode_change start - both runtimes share the same observed-result publication gate
            if (result.type === "native")
              return result.owned?.kind === "directory_entries"
                ? ObservedResult.guard(result.stream, result.owned, sessions, ctrl.signal)
                : result.stream
            // kilocode_change end

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            // kilocode_change start - retain the normalized SDK stream for the publication gate
            const stream = Stream.fromAsyncIterable(
              result.result.fullStream,
              (e) => (e instanceof Error ? e : new Error(String(e))),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
            // kilocode_change end
            // kilocode_change start - keep unverified final text out of the processor and persisted visible parts
            return result.owned?.kind === "directory_entries"
              ? ObservedResult.guard(stream, result.owned, sessions, ctrl.signal)
              : stream
            // kilocode_change end
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

// kilocode_change start - session export stream observer
export { normalizeUsageForExport, observeFullStreamForExport }
// kilocode_change end
export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
    Database.node, // kilocode_change - classify actual persisted Routine ancestry per stream
    Session.node, // kilocode_change - validate original observed-result publication
  ],
})

export * as LLM from "./llm"
