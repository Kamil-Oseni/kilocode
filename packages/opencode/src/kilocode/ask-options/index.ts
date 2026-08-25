// raya_change - Milestone C shared selectable-option contract
import { Effect } from "effect"
import { Question } from "@/question"

export type Option = {
  id: string
  label: string
}

export type Prompt = {
  prompt: string
  options: Option[]
  allow_multiple?: boolean
}

export type Answer = {
  prompt: string
  selected: Option[]
  other: string[]
}

type Input = {
  sessionID: Question.Request["sessionID"]
  questions: Prompt[]
  tool?: Question.Tool
  blocking?: boolean
}

const prefix = "raya-option:"

function wire(id: string) {
  return `${prefix}${id}`
}

function validate(questions: Prompt[]) {
  if (questions.length === 0) throw new Error("ask_options requires at least one question")
  for (const question of questions) {
    if (!question.prompt.trim()) throw new Error("ask_options prompts cannot be empty")
    if (question.options.length < 2) throw new Error("ask_options requires at least two options per question")
    const ids = question.options.map((option) => option.id.trim())
    if (ids.some((id) => !id)) throw new Error("ask_options option ids cannot be empty")
    if (new Set(ids).size !== ids.length) throw new Error("ask_options option ids must be unique per question")
    if (question.options.some((option) => !option.label.trim()))
      throw new Error("ask_options option labels cannot be empty")
  }
}

export namespace RayaAskOptions {
  export function request(input: Input) {
    validate(input.questions)
    return {
      sessionID: input.sessionID,
      questions: input.questions.map((question) => ({
        header: "Choose option",
        question: question.prompt,
        options: question.options.map((option) => ({
          id: wire(option.id),
          label: option.label,
          description: "",
        })),
        multiple: question.allow_multiple === true,
        custom: true,
      })),
      blocking: input.blocking ?? true,
      autoSubmit: input.questions.length === 1 && input.questions[0]?.allow_multiple !== true,
      tool: input.tool,
    }
  }

  export function decode(questions: Prompt[], answers: ReadonlyArray<ReadonlyArray<string>>): Answer[] {
    return questions.map((question, index) => {
      const selected: Option[] = []
      const other: string[] = []
      for (const value of answers[index] ?? []) {
        const option = question.options.find((item) => wire(item.id) === value || item.label === value)
        if (option) {
          if (!selected.some((item) => item.id === option.id)) selected.push(option)
          continue
        }
        other.push(value)
      }
      return {
        prompt: question.prompt,
        selected,
        other,
      }
    })
  }

  export const ask = Effect.fn("RayaAskOptions.ask")(function* (question: Question.Interface, input: Input) {
    const answers = yield* question.ask(request(input))
    return decode(input.questions, answers)
  })

  export function confirm(prompt: string): Prompt {
    return {
      prompt,
      options: [
        { id: "confirm", label: "Confirm" },
        { id: "cancel", label: "Cancel" },
      ],
      allow_multiple: false,
    }
  }
}
