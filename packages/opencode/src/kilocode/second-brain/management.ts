import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { Effect, Schema } from "effect"
import type { Session } from "@/session/session"
import type { Question } from "@/question"
import type * as Tool from "@/tool/tool"
import { RayaAskOptions } from "@/kilocode/ask-options"
import { KiloQuestionTool } from "@/kilocode/tool/question"
import type { SecondBrain } from "./service"
import { Manage, type ManageResult } from "./management-protocol"
import { current, valid, result } from "./management-source"
import { command as checked } from "./refusal"

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000), Schema.isPattern(/\S/))
export const Params = Schema.Struct({
  action: Schema.Literals(["remember", "correct", "forget"]),
  text: Schema.optional(text),
  query: Schema.optional(text),
})

/** Derive actual fact and target spans from an explicit original request, never an assistant summary. */
export function requested(text: string) {
  const prefix =
    /^(?:please |(?:can|could) you (?:please )?|I (?:want|would like) (?:you )?to )?/i.exec(text.trim())?.[0] ?? ""
  const offset = text.indexOf(text.trim()) + prefix.length
  const body = text
    .slice(offset)
    .trimEnd()
    .replace(/[.!?]$/, "")
  const remember =
    /^(?:remember(?: (?:that|this))?:?|(?:save|store)(?: (?:this|that)(?: in (?:my |personal )?memory)?| in (?:my |personal )?memory):?)[ \t\r\n]+([\s\S]+)$/i.exec(
      body,
    )
  const record =
    /^record (?:this|that)(?: [^.!?:\r\n]{1,120})? in my (?:personal memory|SecondBrain(?: memory)?|Raya project memory):[ \t\r\n]+([\s\S]+)$/i.exec(
      body,
    )
  const fact = remember?.[1] ?? record?.[1]
  if (fact) {
    const start = offset + body.length - fact.length
    return { mode: "remember" as const, fact: { start, end: start + fact.length } }
  }
  const correct = /^(?:correct|update|change) (?:my )?(.+?) (?:to|is) ([\s\S]+)$/i.exec(body)
  if (
    correct &&
    /\b(?:memory|remembered|saved (?:fact|information)|preferences?|favo[u]?rite|address|location|name|birthday|phone(?: number)?|email(?: address)?)\b/i.test(
      correct[1],
    ) &&
    (/\b(?:memory|remembered|saved (?:fact|information))\b/i.test(correct[1]) ||
      !/\b(?:code|files?|lights?|devices?|servers?|variables?|functions?|programs?)\b/i.test(correct[1]))
  ) {
    const start = offset + body.length - correct[2].length
    return { mode: "correct" as const, fact: { start, end: start + correct[2].length }, query: correct[1] }
  }
  const forget = /^(?:forget|remove from (?:my |personal )?memory) (?:my )?(.+)$/i.exec(body)
  return forget ? { mode: "forget" as const, query: forget[1] } : undefined
}

export function command(source: Manage["source"], args: typeof Params.Type): Manage {
  const selected = requested(source.text)
  if (!selected || selected.mode !== args.action)
    throw new Error(
      "Please send a new explicit personal Memory request, such as 'Remember this: I prefer tea', 'Update my drink preference to coffee', or 'Forget my drink preference'. No Memory change was requested from this wording.",
    )
  const fact = selected.fact ? source.text.slice(selected.fact.start, selected.fact.end) : undefined
  if (args.text !== undefined && args.text !== fact) throw new Error("The fact must match the exact original user span")
  if (args.query !== undefined && args.query !== ("query" in selected ? selected.query : undefined))
    throw new Error("The target must match the original request")
  const hash = createHash("sha256")
    .update(JSON.stringify([source.source_sha256, selected]))
    .digest("hex")
  const operation = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  const value = { ...selected, action: "manage" as const, stage: "inspect" as const, operation, source }
  if (!valid(value)) throw new Error("The original personal Memory source is not admissible")
  return value
}

/** Carry only original source and host-owned nonce choices through the existing conversation cards. */
export const manage = Effect.fn("SecondBrain.manage")(function* (input: {
  brain: Pick<SecondBrain.Interface, "request">
  question: Question.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  ctx: Tool.Context
  project: string
  args: typeof Params.Type
}) {
  const load = Effect.fn("SecondBrain.manage.source")(function* () {
    input.ctx.abort.throwIfAborted()
    const session = yield* input.sessions.get(input.ctx.sessionID)
    if (
      session.parentID ||
      session.metadata?.rayaRoutine !== undefined ||
      path.resolve(session.directory) !== path.resolve(input.project)
    )
      throw new Error("Original personal Memory conversation changed")
    const messages = yield* input.sessions.messages({ sessionID: input.ctx.sessionID })
    const assistant = messages.find((row) => row.info.id === input.ctx.messageID)
    if (!assistant || assistant.info.role !== "assistant" || assistant.info.sessionID !== session.id)
      throw new Error("Original personal Memory tool owner is missing")
    const source = current(messages, session, assistant.info.parentID)
    if (!source) throw new Error("Original personal Memory user source changed or is unavailable")
    if (!isDeepStrictEqual(current(input.ctx.messages, session, assistant.info.parentID), source))
      throw new Error("Original personal Memory request differs from this tool's conversation")
    return source
  })
  const source = yield* load()
  const original = yield* checked(source, input.args, input.ctx)
  const state: { attempt?: string; closed: boolean } = { closed: false }
  const send = Effect.fn("SecondBrain.manage.request")(function* (request: Manage, cleanup = false) {
    if (!cleanup && !isDeepStrictEqual(yield* load(), source)) throw new Error("Original user Memory source changed")
    if (request.stage === "cancel") state.closed = true
    const value = yield* input.brain.request({
      sessionID: input.ctx.sessionID,
      project: input.project,
      command: request,
    })
    if (value.action !== "manage" || !result(request, value))
      throw new Error("Original personal Memory receipt required")
    state.attempt = value.attempt
    state.closed = value.disposition !== "pending" || !value.question
    return value
  })
  return yield* Effect.gen(function* () {
    let value: ManageResult = yield* send(original)
    for (let index = 0; value.question && index < 4; index++) {
      if (!value.attempt || !value.stage) throw new Error("Original Memory choice receipt is incomplete")
      yield* KiloQuestionTool.admit(input.ctx, "ask_options")
      const answers = yield* RayaAskOptions.ask(input.question, {
        sessionID: input.ctx.sessionID,
        questions: [{ ...value.question, allow_multiple: false }],
        tool: input.ctx.callID ? { messageID: input.ctx.messageID, callID: input.ctx.callID } : undefined,
      }).pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed([])))
      const answer = answers[0]
      const choice = answer?.other.length === 0 && answer.selected.length === 1 ? answer.selected[0].id : undefined
      if (!choice || !value.question.options.some((option) => option.id === choice))
        return yield* send({ ...original, stage: "cancel", attempt: value.attempt })
      value = yield* send({ ...original, stage: value.stage, attempt: value.attempt, choice })
    }
    if (value.question && value.attempt) return yield* send({ ...original, stage: "cancel", attempt: value.attempt })
    return value
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        if (!state.attempt || state.closed) return
        yield* send({ ...original, stage: "cancel", attempt: state.attempt }, true).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchCause((err) =>
            Effect.sync(() => console.warn("Personal Memory cancellation remains unconfirmed", err)),
          ),
        )
      }),
    ),
  )
})
