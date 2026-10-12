import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Recall, Status } from "@/kilocode/second-brain/protocol"
import { SecondBrain, HostError } from "@/kilocode/second-brain/service"
import { fit, reserve } from "@/kilocode/second-brain/context"
import { requested, setup } from "@/kilocode/second-brain/setup"
import { RayaChief } from "@/kilocode/chief"
import { Question } from "@/question"
import * as Tool from "@/tool/tool"

const Params = Schema.Union([
  Status,
  Schema.Struct({ action: Schema.Literal("setup") }),
  Schema.Struct({ query: Recall.fields.query, budget: Schema.optional(Recall.fields.budget) }),
])

function cancelled(signal: AbortSignal, operation: "context" | "status" | "setup" = "context") {
  return Effect.callback<never, HostError>((resume) => {
    const fail = () =>
      resume(Effect.fail(new HostError({ code: "cancelled", detail: "Memory read cancelled", operation })))
    if (signal.aborted) return fail()
    signal.addEventListener("abort", fail, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", fail))
  })
}

export const BrainRecallTool = Tool.define<
  typeof Params,
  { count: number; truncated: boolean; tokens: number },
  SecondBrain.Service | Session.Service
>(
  "second_brain_recall",
  Effect.gen(function* () {
    const brain = yield* SecondBrain.Service
    const sessions = yield* Session.Service
    return {
      description:
        "Use {action:'setup'} when the user asks to connect or set up personal Memory. Setup presents existing conversation option cards for missing choices and native masked credential/review controls; never ask for technical filenames, paths or secrets in chat. Report its actual configured, cancelled or needs_attention receipt; connection does not prove saving and recall. Read setup status with {action:'status'}, or retrieve approved notes with {query, budget?}. Do not re-ask for an already selected folder or authorized capture. Search and linked notes are unverified source candidates: cite supporting passages, preserve qualifiers, and say you do not know when none supports the question. Similarity and citation metadata alone are not facts. Reads do not edit notes or enable capture. Budget is capped by the current request allowance.",
      parameters: Params,
      execute: (args: typeof Params.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const inst = yield* InstanceState.context
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          if (path.resolve(session.directory) !== path.resolve(inst.directory))
            return yield* Effect.die(new Error("Memory recall session directory changed"))
          yield* ctx.ask({
            permission: "action" in args && args.action === "setup" ? "second_brain_setup" : "second_brain_recall",
            patterns: [inst.directory],
            always: [inst.directory],
            metadata: { query: "action" in args ? `Memory ${args.action}` : args.query },
          })
          if ("action" in args && args.action === "setup") {
            const original = ctx.messages.findLast((row) => row.info.role === "user")
            if (!original || !requested(RayaChief.requestText(original.parts)))
              return yield* Effect.die(new Error("An explicit personal Memory setup request is required"))
            const question = yield* Effect.serviceOption(Question.Service)
            if (Option.isNone(question)) return yield* Effect.die(new Error("Conversation setup cards are unavailable"))
            const current = ctx.messages.find((row) => row.info.id === ctx.messageID)
            const model =
              current?.info.role === "assistant"
                ? { providerID: current.info.providerID, modelID: current.info.modelID }
                : original.info.role === "user"
                  ? original.info.model
                  : undefined
            const result = yield* setup({ brain, question: question.value, project: inst.directory, ctx, model }).pipe(
              Effect.raceFirst(cancelled(ctx.abort, "setup")),
              Effect.orDie,
            )
            return {
              title: result.status === "configured" ? "Memory connected" : "Memory setup",
              output: JSON.stringify(result),
              metadata: { count: 0, truncated: false, tokens: 0 },
            }
          }
          if ("action" in args) {
            const lease = yield* Effect.sync(() => reserve(ctx.extra?.memoryContext, 2048, ctx.abort))
            const result = yield* brain
              .request({
                sessionID: ctx.sessionID,
                project: inst.directory,
                command: { action: "status" },
              })
              .pipe(Effect.raceFirst(cancelled(ctx.abort, "status")), Effect.orDie)
            if (result.action !== "status") return yield* Effect.die(new Error("Memory status reply required"))
            return {
              title: "Memory setup status",
              output: lease.check(result),
              metadata: { count: 0, truncated: false, tokens: 0 },
            }
          }
          const lease = yield* Effect.sync(() => reserve(ctx.extra?.memoryContext, args.budget ?? 6000, ctx.abort))
          // Reserve serialization/provenance overhead separately from the service's passage counter.
          const budget = Math.floor((lease.budget - 512) / 1.3)
          if (budget < 1)
            return yield* Effect.die(new Error("Remaining context is too small for a sourced Memory result"))
          const result = yield* brain
            .request({
              sessionID: ctx.sessionID,
              project: inst.directory,
              command: { action: "context", query: args.query, budget },
            })
            .pipe(Effect.raceFirst(cancelled(ctx.abort)), Effect.orDie)
          if (result.action !== "context") return yield* Effect.die(new Error("Memory context reply required"))
          const selected = fit(result, lease.budget)
          return {
            title: "Second Brain recall",
            output: lease.check(selected),
            metadata: {
              count: selected.context.sources.length,
              truncated: selected.context.truncated,
              tokens: selected.context.tokens,
            },
          }
        }),
    }
  }),
)
