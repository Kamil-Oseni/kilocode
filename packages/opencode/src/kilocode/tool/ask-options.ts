// raya_change - Milestone C model-facing selectable options
import { Effect, Schema } from "effect"
import { RayaAskOptions, type Answer } from "@/kilocode/ask-options"
import { Question } from "@/question"
import * as Tool from "@/tool/tool"

const Option = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Stable machine-readable value returned when selected",
  }),
  label: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Concise text shown on the clickable option card",
  }),
})

const Prompt = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The complete decision question shown to the user",
  }),
  options: Schema.Array(Option).check(Schema.isMinLength(2)).annotate({
    description: "Two or more discrete choices",
  }),
  allow_multiple: Schema.optional(Schema.Boolean).annotate({
    description: "Allow the user to select several choices before submitting",
  }),
})

export const Parameters = Schema.Struct({
  questions: Schema.Array(Prompt).check(Schema.isMinLength(1)).annotate({
    description: "One or more decisions that genuinely belong to the user",
  }),
})

type Metadata = {
  answers: Answer[]
  dismissed?: boolean
}

export const AskOptionsTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "ask_options",
  Effect.gen(function* () {
    const question = yield* Question.Service
    return {
      description:
        "Ask the user one or more discrete questions as clickable in-chat option cards. Each question requires at least two options with stable ids. Set allow_multiple when several choices may be selected. An Other free-text choice is always included. Use this instead of asking discrete questions in prose, especially before an unapproved destructive action.",
      parameters: Parameters,
      execute: (params, ctx) =>
        RayaAskOptions.ask(question, {
          sessionID: ctx.sessionID,
          questions: params.questions.map((item) => ({
            prompt: item.prompt,
            options: item.options.map((option) => ({ id: option.id, label: option.label })),
            allow_multiple: item.allow_multiple,
          })),
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        }).pipe(
          Effect.map((answers) => ({
            title: `Asked ${params.questions.length} question${params.questions.length === 1 ? "" : "s"}`,
            output: JSON.stringify({ answers }),
            metadata: { answers },
          })),
          Effect.catchTag("QuestionRejectedError", () =>
            Effect.succeed({
              title: "Question dismissed",
              output: "User dismissed the question.",
              metadata: { answers: [], dismissed: true as const },
            }),
          ),
        ),
    }
  }),
)
