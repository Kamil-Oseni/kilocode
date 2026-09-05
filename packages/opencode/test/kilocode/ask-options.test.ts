// raya_change - Milestone C selectable options runtime tests
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber, Queue, Schema } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Agent } from "../../src/agent/agent"
import { RayaAskOptions } from "../../src/kilocode/ask-options"
import { AskOptionsTool, Parameters } from "../../src/kilocode/tool/ask-options"
import { Question } from "../../src/question"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node])),
)

const ctx = {
  sessionID: SessionID.make("ses_ask-options"),
  messageID: MessageID.make("msg_ask-options"),
  callID: "call-ask-options",
  agent: "ask",
  abort: new AbortController().signal,
  extra: {},
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const pending = Effect.fn("AskOptionsTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const item = (yield* question.list())[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

describe("ask_options", () => {
  test("waits for Submit instead of sending on a single-select click", () => {
    const item = RayaAskOptions.request({
      sessionID: ctx.sessionID,
      questions: [
        {
          prompt: "Which format should I use?",
          options: [
            { id: "markdown", label: "Markdown" },
            { id: "json", label: "JSON" },
          ],
        },
      ],
    })
    expect(item.autoSubmit).toBe(false)
    expect(item.questions[0]?.custom).toBe(true)
  })

  it.instance("renders a single-select card, returns its stable id, and always offers Other", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const info = yield* AskOptionsTool
      const tool = yield* info.init()
      const fiber = yield* tool
        .execute(
          {
            questions: [
              {
                prompt: "Which format should I use?",
                options: [
                  { id: "markdown", label: "Markdown" },
                  { id: "json", label: "JSON" },
                ],
              },
            ],
          },
          ctx,
        )
        .pipe(Effect.forkScoped)
      const item = yield* pending(question)
      const option = item.questions[0]?.options[0]

      expect(item.autoSubmit).toBe(false)
      expect(item.questions[0]?.custom).toBe(true)
      expect(option).toMatchObject({ label: "Markdown" })
      expect(option?.id).toBe("raya-option:markdown")
      yield* question.reply({ requestID: item.id, answers: [[option!.id!]] })

      const result = yield* Fiber.join(fiber)
      expect(JSON.parse(result.output)).toEqual({
        answers: [
          {
            prompt: "Which format should I use?",
            selected: [{ id: "markdown", label: "Markdown" }],
            other: [],
          },
        ],
      })
    }),
  )

  it.instance("returns several selected ids and an Other free-text answer", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const info = yield* AskOptionsTool
      const tool = yield* info.init()
      const fiber = yield* tool
        .execute(
          {
            questions: [
              {
                prompt: "Which checks should run?",
                options: [
                  { id: "types", label: "Typecheck" },
                  { id: "tests", label: "Tests" },
                  { id: "lint", label: "Lint" },
                ],
                allow_multiple: true,
              },
            ],
          },
          ctx,
        )
        .pipe(Effect.forkScoped)
      const item = yield* pending(question)

      expect(item.autoSubmit).toBe(false)
      expect(item.questions[0]?.multiple).toBe(true)
      yield* question.reply({
        requestID: item.id,
        answers: [["raya-option:types", "raya-option:tests", "Run the smoke test too"]],
      })

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.answers).toEqual([
        {
          prompt: "Which checks should run?",
          selected: [
            { id: "types", label: "Typecheck" },
            { id: "tests", label: "Tests" },
          ],
          other: ["Run the smoke test too"],
        },
      ])
    }),
  )

  it.instance("builds destructive confirmations from the same contract", () =>
    Effect.sync(() => {
      expect(RayaAskOptions.confirm("Delete this session?")).toEqual({
        prompt: "Delete this session?",
        options: [
          { id: "confirm", label: "Confirm" },
          { id: "cancel", label: "Cancel" },
        ],
        allow_multiple: false,
      })
      expect(
        Schema.is(Parameters)({
          questions: [{ prompt: "Choose", options: [{ id: "only", label: "Only choice" }] }],
        }),
      ).toBe(false)
    }),
  )
})
