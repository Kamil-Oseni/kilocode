import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { Question } from "@/question"
import type * as Tool from "@/tool/tool"
import { RayaAskOptions } from "@/kilocode/ask-options"
import { KiloQuestionTool } from "@/kilocode/tool/question"
import type { SecondBrain } from "./service"
import type { Setup, SetupResult } from "./protocol"

const log = Log.create({ service: "memory.setup" })

export function requested(text: string) {
  return /^(?:please |I (?:want|would like) (?:you )?to |(?:Can|Could) you (?:please )?|Let's )?(?:set up|setup|connect|configure|enable) (?:(?:my|personal|Raya's|local) )*(?:Memory|SecondBrain|second brain)(?: (?:(?:for|in|with) Raya|for me))?(?:,? please)?[.!?]?$/i.test(
    text.trim(),
  )
}

/** Host-owned setup choices use the ordinary conversation cards; secrets stay in native input. */
export const setup = Effect.fn("SecondBrain.setup")(function* (input: {
  brain: SecondBrain.Interface
  question: Question.Interface
  project: string
  ctx: Tool.Context
  model?: { providerID: string; modelID: string }
}) {
  const state: { attempt?: string; closed: boolean } = { closed: false }
  const send = (command: typeof Setup.Type) =>
    Effect.sync(() => {
      if (command.stage === "cancel") state.closed = true
    }).pipe(
      Effect.andThen(input.brain.request({ sessionID: input.ctx.sessionID, project: input.project, command })),
      Effect.flatMap((value) =>
        value.action === "setup"
          ? Effect.succeed(value)
          : Effect.die(new Error("Original Memory setup receipt required")),
      ),
      Effect.tap((value) =>
        Effect.sync(() => {
          state.attempt = value.attempt
          state.closed = value.status !== "choice"
        }),
      ),
    )
  return yield* Effect.gen(function* () {
    let value: SetupResult = yield* send({
      action: "setup",
      stage: "inspect",
      ...(input.model ? { model: input.model } : {}),
    })
    for (let index = 0; value.status === "choice" && index < 4; index++) {
      input.ctx.abort.throwIfAborted()
      const prompt = value.question
      if (!prompt) return yield* Effect.die(new Error("Memory setup choice is missing"))
      yield* KiloQuestionTool.admit(input.ctx, "ask_options")
      const answers = yield* RayaAskOptions.ask(input.question, {
        sessionID: input.ctx.sessionID,
        questions: [{ ...prompt, allow_multiple: false }],
        tool: input.ctx.callID ? { messageID: input.ctx.messageID, callID: input.ctx.callID } : undefined,
      }).pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed([])))
      const answer = answers[0]
      const choice = answer?.other.length === 0 && answer.selected.length === 1 ? answer.selected[0].id : undefined
      value = yield* send(
        !choice || choice === "cancel"
          ? { action: "setup", stage: "cancel", attempt: value.attempt }
          : { action: "setup", stage: "continue", attempt: value.attempt, choice },
      )
    }
    if (value.status === "choice") {
      value = yield* send({ action: "setup", stage: "cancel", attempt: value.attempt })
    }
    return value
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (!state.attempt || state.closed) return
        yield* send({ action: "setup", stage: "cancel", attempt: state.attempt }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchCause((err) => Effect.sync(() => log.warn("Memory setup cancellation is unconfirmed", { err }))),
        )
      }),
    ),
  )
})
