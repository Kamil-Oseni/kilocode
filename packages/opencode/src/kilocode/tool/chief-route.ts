// raya_change - Milestone B intelligent auto-routing
import { Effect, Option, Schema, Semaphore } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RayaAskOptions } from "@/kilocode/ask-options" // raya_change - Milestone C shared option cards
import { RayaChief } from "@/kilocode/chief"
import { HomeAssistant } from "@/kilocode/home-assistant/tools"
import { KiloTask } from "@/kilocode/tool/task"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { Permission } from "@/permission"
import { ChiefRefinement } from "@/kilocode/chief/refinement"
import { gate } from "@/kilocode/session/input-gate"
import * as Tool from "@/tool/tool"

export const Parameters = Schema.Struct({
  access: Schema.optional(RayaChief.Access).annotate({
    description:
      "Requested work class: read for inspection, edit for requested file changes, computer for desktop actions. Set explicitly for every fresh route and carry the chosen class into Task. This does not grant permissions. Omission is supported only for legacy calls and does not infer edit work from the objective.",
  }),
  objective: Schema.String.annotate({ description: "The user's complete request, copied without narrowing its scope" }),
  workflow: Schema.optional(
    Schema.Literals(["specialist", "home_assistant"]).annotate({
      description:
        "Select home_assistant only for connected light inspection/control requested in this turn; otherwise specialist.",
    }),
  ),
})

type Metadata = {
  decision?: RayaChief.Decision
  workflow?: "home_assistant"
}

const gates = new Map<string, { semaphore: ReturnType<typeof Semaphore.makeUnsafe>; refs: number }>()

function locked<A, E, R>(key: string, body: Effect.Effect<A, E, R>, signal: AbortSignal) {
  const cancelled = Effect.callback<never>((resume) => {
    if (signal.aborted) return resume(Effect.interrupt)
    const stop = () => resume(Effect.interrupt)
    signal.addEventListener("abort", stop, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", stop))
  })
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const gate = gates.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), refs: 0 }
      gate.refs++
      gates.set(key, gate)
      return gate
    }),
    (gate) => gate.semaphore.withPermits(1)(body),
    (gate) =>
      Effect.sync(() => {
        gate.refs--
        if (gate.refs === 0 && gates.get(key) === gate) gates.delete(key)
      }),
  ).pipe(Effect.raceFirst(cancelled))
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
    const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service))

    return {
      description:
        "Classify the complete user request through Raya's Chief policy. Call once for each new Auto request. A direct decision needs no child; other decisions may delegate. Ask the user to choose when confidence is low.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const original = yield* sessions
            .findMessage(ctx.sessionID, (item) => item.info.id === ctx.messageID)
            .pipe(Effect.orDie)
          if (Option.isNone(original) || original.value.info.role !== "assistant")
            throw new Error("Auto routing requires the original assistant dispatch")
          const user = original.value.info.parentID
          return yield* locked(
            `${ctx.sessionID}:${user}`,
            Effect.gen(function* () {
              if (ctx.abort.aborted) return yield* Effect.interrupt
              const started = Date.now()
              const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
              const dispatch = yield* sessions.messages({ sessionID: ctx.sessionID })
              if (dispatch.findLast((item) => item.info.role === "user")?.info.id !== user)
                throw new Error("Auto routing requires the current original user dispatch")
              if (params.workflow === "home_assistant") {
                const messages = yield* sessions.messages({ sessionID: ctx.sessionID })
                const latest = messages.findLast((item) => item.info.role === "user")
                const current = messages.find((item) => item.info.id === ctx.messageID)
                const request = RayaChief.request(session.metadata)
                if (
                  session.parentID ||
                  RayaChief.phase(session.metadata) !== "route" ||
                  latest?.info.role !== "user" ||
                  latest.info.agent !== "auto" ||
                  current?.info.role !== "assistant" ||
                  current.info.agent !== "auto" ||
                  current.info.parentID !== latest.info.id ||
                  current.info.sessionID !== session.id ||
                  latest.info.sessionID !== session.id ||
                  !request ||
                  RayaChief.requestText(latest.parts) !== request
                )
                  throw new Error("Home Assistant selection requires the current original Auto request")
                if (HomeAssistant.selected(session.metadata, { session: session.id, user: latest.info.id }))
                  throw new Error("Home Assistant was already selected for this request")
                yield* sessions.setMetadata({
                  sessionID: ctx.sessionID,
                  metadata: {
                    ...session.metadata,
                    [HomeAssistant.key]: { session: session.id, user: latest.info.id, request },
                  },
                })
                return {
                  title: "Auto to Home Assistant",
                  output: JSON.stringify({
                    workflow: "home_assistant",
                    direct: true,
                    instruction:
                      "Use registered device tools directly for this selected request. Honor approvals; report unavailable tools or uncertain readback truthfully.",
                  }),
                  metadata: { workflow: "home_assistant" as const },
                }
              }
              const refinement =
                RayaChief.phase(session.metadata) === "task" &&
                RayaChief.follow(session.metadata)?.access === undefined &&
                params.access !== undefined
                  ? storage
                    ? yield* ChiefRefinement.check({ session, sessions, storage, ctx, access: params.access })
                    : yield* Effect.die(new Error("Chief refinement requires durable storage"))
                  : undefined
              if (RayaChief.phase(session.metadata) !== "route" && !refinement) {
                const decision = RayaChief.history(session.metadata).at(-1)
                if (!decision) return yield* Effect.die(new Error("Auto routing phase advanced without a decision"))
                return {
                  title: "Auto already routed",
                  output: decision.direct
                    ? "Routing is complete. Answer this self-contained request directly."
                    : "Routing is already complete for this turn. Continue with task, then goal verification.",
                  metadata: { decision },
                }
              } // raya_change - repeated same-response calls stay known but cannot restart the workflow
              const cfg = yield* config.get() // raya_change - Milestone I runtime routing settings
              const threshold = cfg.raya_routing?.confidence_threshold // raya_change - Milestone I
              const caller = refinement ? yield* agents.get("auto") : undefined
              const rules = caller ? Permission.merge(caller.permission, session.permission ?? []) : undefined
              const available = (yield* agents.list()).filter(
                (item) =>
                  item.mode !== "primary" &&
                  !item.hidden &&
                  !item.deprecated &&
                  (!rules || Permission.evaluate("task", item.name, rules).action !== "deny"),
              )
              // raya_change start - route the persisted user text, never a model-rewritten objective
              const request = RayaChief.request(session.metadata) ?? params.objective
              const initial = RayaChief.route({ request, agents: available, access: params.access })
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
              if (!selected || (params.access && !RayaChief.capable(selected, params.access)))
                throw new Error("The selected Auto specialist is unavailable")
              const direct =
                selected.name === "generalist" &&
                !params.access &&
                !answer &&
                RayaChief.request(session.metadata) === request &&
                session.metadata?.["raya.goal.open"] !== true &&
                RayaChief.direct(request)

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
              const resolved = direct
                ? undefined
                : yield* KiloTask.resolveModel({
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
                ...(params.access ? { access: params.access, userID: user } : {}),
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
              if (direct) pending.direct = true
              const decision: RayaChief.Decision = {
                ...pending,
                model: resolved ? `${resolved.model.providerID}/${resolved.model.modelID}` : chiefModel,
              }
              if (ctx.abort.aborted) return yield* Effect.interrupt
              const commit = Effect.gen(function* () {
                const current = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
                const messages = yield* sessions.messages({ sessionID: ctx.sessionID })
                const latest = messages.findLast((item) => item.info.role === "user")
                if (
                  latest?.info.id !== user ||
                  RayaChief.request(current.metadata) !== RayaChief.request(session.metadata) ||
                  RayaChief.phase(current.metadata) !== (refinement ? "task" : "route") ||
                  HomeAssistant.selected(current.metadata, { session: ctx.sessionID, user })
                )
                  throw new Error("Auto routing dispatch changed before its decision was committed")
                if (refinement) {
                  const checked = yield* ChiefRefinement.check({
                    session: current,
                    sessions,
                    storage: storage!,
                    ctx,
                    access: params.access!,
                  })
                  if (checked.previous !== refinement.previous)
                    throw new Error("Chief classification changed before refinement")
                }
                yield* sessions.setMetadata({
                  sessionID: ctx.sessionID,
                  metadata: {
                    ...current.metadata,
                    ...(refinement ? { [ChiefRefinement.key]: refinement } : {}),
                    [RayaChief.pendingKey]: pending,
                    [RayaChief.phaseKey]: direct ? "done" : "task",
                    [RayaChief.logKey]: [...RayaChief.history(current.metadata), decision],
                  },
                })
              })
              yield* refinement ? gate.withLock(ctx.sessionID)(commit) : commit
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
            }),
            ctx.abort,
          )
        }).pipe(Effect.orDie),
    }
  }),
)
