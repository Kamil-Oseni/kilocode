// raya_change - Milestone B intelligent auto-routing
import { Effect, Option, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RayaAskOptions } from "@/kilocode/ask-options" // raya_change - Milestone C shared option cards
import { RayaChief } from "@/kilocode/chief"
import { KiloTask } from "@/kilocode/tool/task"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session/session"
import * as Tool from "@/tool/tool"

export const Parameters = Schema.Struct({
  objective: Schema.String.annotate({ description: "The user's complete request, copied without narrowing its scope" }),
})

type Metadata = {
  decision: RayaChief.Decision
}

export const ChiefRouteTool = Tool.define<
  typeof Parameters,
  Metadata,
  Agent.Service | Config.Service | Provider.Service | Question.Service | Session.Service
>(
  "chief_route",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const question = yield* Question.Service
    const sessions = yield* Session.Service

    return {
      description:
        "Classify the complete user request through Raya's Chief policy. This must be called exactly once before task in Auto mode. It validates and logs a strict routing decision and asks the user to choose when confidence is low.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const started = Date.now()
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const cfg = yield* config.get() // raya_change - Milestone I runtime routing settings
          const threshold = cfg.raya_routing?.confidence_threshold // raya_change - Milestone I
          const available = (yield* agents.list()).filter(
            (item) => item.mode !== "primary" && !item.hidden && !item.deprecated,
          )
          // raya_change start - route the persisted user text, never a model-rewritten objective
          const request = RayaChief.request(session.metadata) ?? params.objective
          const initial = RayaChief.route({ request, agents: available })
          // raya_change end
          // raya_change start - Milestone C low-confidence routing reuses ask_options
          const answer = RayaChief.needsPrompt(initial, threshold, request)
            ? yield* RayaAskOptions.ask(question, {
                sessionID: ctx.sessionID,
                questions: [RayaChief.question(initial)],
                blocking: true,
                tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
              })
            : undefined
          const chosen = answer?.[0]?.selected[0]?.id ?? answer?.[0]?.other[0] ?? initial.agent
          const selected = available.find((item) => item.name === chosen)
          // raya_change end
          if (!selected) throw new Error("The selected Auto specialist is unavailable")

          const message = yield* sessions
            .findMessage(ctx.sessionID, (item) => item.info.id === ctx.messageID)
            .pipe(Effect.orDie)
          const assistant =
            Option.isSome(message) && message.value.info.role === "assistant" ? message.value.info : undefined
          const saved = RayaChief.parent(session.metadata)
          const parent = saved
            ? {
                providerID: ProviderV2.ID.make(saved.providerID),
                modelID: ModelV2.ID.make(saved.modelID),
              }
            : assistant
              ? { providerID: assistant.providerID, modelID: assistant.modelID }
              : yield* provider.defaultModel()
          const resolved = yield* KiloTask.resolveModel({
            name: selected.name,
            agent: selected,
            config: cfg,
            parent,
            variant: saved?.variant,
            provider,
          })
          const chiefModel = assistant
            ? `${assistant.providerID}/${assistant.modelID}`
            : `${parent.providerID}/${parent.modelID}`
          const candidate = initial.candidates.find((item) => item.agent === selected.name)
          const pending: RayaChief.Pending = {
            request,
            agent: selected.name,
            role: candidate?.role ?? initial.role,
            needs_plan: candidate?.role === "reasoner" || initial.needs_plan,
            confidence: initial.confidence,
            reason:
              selected.name === initial.agent
                ? initial.reason
                : `The user selected ${selected.name} after Auto reported low confidence.`,
            candidates: initial.candidates,
            prompted: RayaChief.needsPrompt(initial, threshold, request),
            latency: Math.max(0, Date.now() - (assistant?.time.created ?? started)),
            chiefModel,
          }
          const decision: RayaChief.Decision = {
            ...pending,
            model: `${resolved.model.providerID}/${resolved.model.modelID}`,
          }
          yield* sessions.setMetadata({
            sessionID: ctx.sessionID,
            metadata: {
              ...session.metadata,
              [RayaChief.pendingKey]: pending,
              [RayaChief.phaseKey]: "task", // raya_change - only task is legal after Chief
              [RayaChief.logKey]: [...RayaChief.history(session.metadata), decision],
            },
          })
          yield* Effect.logInfo("raya chief decision", {
            agent: decision.agent,
            model: decision.model,
            confidence: decision.confidence,
            reason: decision.reason,
            latency: decision.latency,
            chiefModel: decision.chiefModel,
          })

          return {
            title: `Auto → ${decision.agent}`,
            output: JSON.stringify(decision),
            metadata: { decision },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
