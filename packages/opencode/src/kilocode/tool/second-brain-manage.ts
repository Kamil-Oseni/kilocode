import { Effect, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Question } from "@/question"
import { SecondBrain } from "@/kilocode/second-brain/service"
import { Params, manage } from "@/kilocode/second-brain/management"
import * as Tool from "@/tool/tool"

function aborted(signal: AbortSignal) {
  return Effect.callback<never, Error>((resume) => {
    const stop = () =>
      resume(Effect.fail(new Error("Original personal Memory change was cancelled; inspect its retained receipt")))
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", stop))
  })
}

export const BrainManageTool = Tool.define<
  typeof Params,
  { published: boolean; indexed: boolean },
  SecondBrain.Service | Session.Service
>(
  "second_brain_manage",
  Effect.gen(function* () {
    const brain = yield* SecondBrain.Service
    const sessions = yield* Session.Service
    return {
      description:
        "Remember, correct or forget a personal Memory only when the current user explicitly requests that change, including recording an outcome in their SecondBrain or Raya project memory. Prefer action alone: the host derives the fact and target from the original user request. Optional text and query must match those exact original spans; never paraphrase or summarize them. Workspace code memory uses kilo_memory_save instead. Never supply paths, hashes, approvals or settings. Host-owned conversation cards choose exact entries; native human review approves publication. Published and indexed are separate receipt states. Forget removes active recall, not backups. Never replay an unconfirmed operation; inspect its original receipt.",
      parameters: Params,
      execute: (args: typeof Params.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const project = (yield* InstanceState.context).directory
          const question = yield* Effect.serviceOption(Question.Service)
          if (Option.isNone(question)) throw new Error("Personal Memory conversation cards are unavailable")
          yield* ctx.ask({
            permission: "second_brain_manage",
            patterns: [project],
            always: [project],
            metadata: { action: args.action },
          })
          const value = yield* manage({ brain, sessions, question: question.value, ctx, project, args }).pipe(
            Effect.raceFirst(aborted(ctx.abort)),
            Effect.orDie,
          )
          return {
            title: "Personal Memory change",
            output: JSON.stringify(value),
            metadata: { published: value.publication_confirmed, indexed: value.index_confirmed },
          }
        }),
    }
  }),
)
