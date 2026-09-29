import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder" // kilocode_change
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { KiloQuestion } from "@/kilocode/question" // kilocode_change
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
// kilocode_change start - await retained worker authority before releasing answers
import { Database } from "@opencode-ai/core/database/database"
import { Storage } from "@/storage/storage"
import { make as replyGate, approve, accept } from "@/kilocode/task/reply"
// kilocode_change end

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    blocking?: boolean // kilocode_change
    autoSubmit?: boolean // kilocode_change // raya_change - Milestone C clickable option cards
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly dismissAll: (sessionID: SessionID) => Effect.Effect<void> // kilocode_change
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    // kilocode_change start
    const deps = { database: yield* Database.Service, storage: yield* Storage.Service }
    const gate = replyGate(deps)
    const wait = replyGate(deps, true)
    // kilocode_change end
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      blocking?: boolean // kilocode_change
      autoSubmit?: boolean // kilocode_change // raya_change - Milestone C clickable option cards
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        blocking: input.blocking, // kilocode_change
        autoSubmit: input.autoSubmit, // kilocode_change // raya_change - Milestone C clickable option cards
        tool: input.tool,
      }

      // kilocode_change start
      yield* KiloQuestion.guardFollowup(input.sessionID, () => new RejectedError())
      yield* approve(wait, input.sessionID)
      // kilocode_change end

      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        // kilocode_change start - every asked question gets a terminal event when its waiter is interrupted
        KiloQuestion.finalize({
          pending,
          id,
          publishRejected: () => events.publish(Event.Rejected, { sessionID: info.sessionID, requestID: info.id }),
        }),
        // kilocode_change end
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logDebug("reply for unknown request", { requestID: input.requestID }) // kilocode_change
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      yield* approve(gate, existing.info.sessionID) // kilocode_change - denied answers remain pending with an explicit request failure
      if (pending.get(input.requestID) !== existing) return // kilocode_change - a concurrent reject owns the waiter
      // kilocode_change start - accept before publishing; publication is an observation, not authority
      if (!(yield* accept(pending, input.requestID, existing, Deferred.succeed(existing.deferred, input.answers))))
        return
      // kilocode_change end
      yield* Effect.logInfo("replied", { requestID: input.requestID }) // kilocode_change - free-text answers may contain secrets
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logDebug("reject for unknown request", { requestID }) // kilocode_change
        return yield* new NotFoundError({ requestID })
      }
      yield* gate(existing.info.sessionID) // kilocode_change - valid dismissal restores WAIT; refused authority never prevents cancellation
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    // kilocode_change start - body lives in @/kilocode/question/KiloQuestion.makeDismissAll
    const dismissAll = KiloQuestion.makeDismissAll({
      state,
      publishRejected: (entry) =>
        events.publish(Event.Rejected, { sessionID: entry.info.sessionID, requestID: entry.info.id }),
      makeError: () => new RejectedError(),
    })
    // kilocode_change end

    return Service.of({ ask, reply, reject, list, dismissAll }) // kilocode_change
  }),
)

// kilocode_change - preserve legacy layer composition for Kilo callers
export const defaultLayer = Layer.suspend(() => AppNodeBuilder.build(node)) // kilocode_change

// kilocode_change start
export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Database.node, Storage.node],
})
// kilocode_change end

export * as Question from "."
