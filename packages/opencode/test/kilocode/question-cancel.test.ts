import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Queue, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Question } from "../../src/question"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { QuestionID } from "../../src/question/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { AskOptionsTool } from "@/kilocode/tool/ask-options"
import { QuestionTool } from "@/tool/question"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node, Agent.node, Truncate.node])),
)

for (const kind of ["ask_options", "question"] as const) {
  for (const pre of [false, true]) {
    it.instance(`tool question cancellation follows its AbortSignal: ${kind}, pre-aborted=${pre}`, () =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const bridge = yield* EventV2Bridge.Service
        const asked = yield* Queue.unbounded<Question.Request>()
        const rejected = yield* Queue.unbounded<{ sessionID: SessionID; requestID: QuestionID }>()
        const seen: Question.Request[] = []
        const off = yield* bridge.listen((event) => {
          if (event.type === Question.Event.Asked.type) {
            const request = Schema.decodeUnknownSync(Question.Request)(event.data)
            seen.push(request)
            Queue.offerUnsafe(asked, request)
          }
          if (event.type === Question.Event.Rejected.type)
            Queue.offerUnsafe(rejected, Schema.decodeUnknownSync(Question.Rejected)(event.data))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)
        yield* question.ask({
          sessionID: SessionID.make("ses_unrelated_question"),
          questions: [{ header: "Retained", question: "Keep this unrelated question?", options: [] }],
        }).pipe(Effect.forkScoped)
        const other = yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
        const controller = new AbortController()
        if (pre) controller.abort()
        const ctx = {
          sessionID: SessionID.make("ses_tool_question_abort"),
          messageID: MessageID.make("msg_tool_question_abort"),
          callID: "tool-question-abort",
          agent: "auto",
          abort: controller.signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const work = Effect.gen(function* () {
          if (kind === "ask_options") {
            const info = yield* AskOptionsTool
            const tool = yield* info.init()
            return yield* tool.execute({ questions: [{
              prompt: "Continue this disposable test?",
              options: [{ id: "continue", label: "Continue" }, { id: "stop", label: "Stop" }],
            }] }, ctx)
          }
          const info = yield* QuestionTool
          const tool = yield* info.init()
          return yield* tool.execute({ questions: [{
            header: "Disposable",
            question: "Continue this disposable test?",
            options: [{ label: "Continue", description: "Continue" }, { label: "Stop", description: "Stop" }],
          }] }, ctx)
        })
        const fiber = yield* work.pipe(Effect.exit, Effect.forkScoped)
        const request = pre ? undefined : yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
        if (!pre) controller.abort()
        const exit = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(yield* question.list()).toEqual([other])
        if (request) {
          expect(yield* Queue.take(rejected).pipe(Effect.timeout("2 seconds"))).toEqual({
            sessionID: request.sessionID,
            requestID: request.id,
          })
        }
        expect(seen.filter((request) => request.sessionID === ctx.sessionID)).toHaveLength(pre ? 0 : 1)
      }),
    )
  }
}

afterEach(async () => {
  await disposeAllInstances()
})

it.instance(
  "publishes rejection when a pending question is interrupted",
  () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const bridge = yield* EventV2Bridge.Service
      const asked = yield* Queue.unbounded<{ properties: Question.Request }>()
      const rejected = yield* Queue.unbounded<{
        properties: { sessionID: SessionID; requestID: QuestionID }
      }>()
      const off = yield* bridge.listen((event) => {
        if (event.type === Question.Event.Asked.type)
          Queue.offerUnsafe(asked, { properties: event.data as Question.Request })
        if (event.type === Question.Event.Rejected.type)
          Queue.offerUnsafe(rejected, {
            properties: event.data as { sessionID: SessionID; requestID: QuestionID },
          })
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const fiber = yield* question
        .ask({
          sessionID: SessionID.make("ses_test"),
          questions: [
            {
              header: "Snapshot",
              question: "Keep waiting?",
              options: [{ label: "Continue", description: "Keep waiting" }],
            },
          ],
        })
        .pipe(Effect.forkChild)
      const request = yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))

      yield* Fiber.interrupt(fiber)

      const event = yield* Queue.take(rejected).pipe(Effect.timeout("2 seconds"))
      expect(event.properties).toEqual({
        sessionID: request.properties.sessionID,
        requestID: request.properties.id,
      })
      expect(yield* question.list()).toEqual([])
    }),
  { git: true },
)
