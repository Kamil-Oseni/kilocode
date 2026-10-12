import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Bus } from "@/bus"
import { Question } from "@/question"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { RequestID, Setup, type Request, type SetupResult } from "@/kilocode/second-brain/protocol"
import { SecondBrain } from "@/kilocode/second-brain/service"
import { requested, setup } from "@/kilocode/second-brain/setup"
import { valid } from "@/kilocode/second-brain/reply"
import { testEffect, pollWithTimeout } from "../../lib/effect"

const attempt = "b43ff5f0-6049-4009-905a-7649022ee5b7"
const sid = SessionID.make("ses_memory_setup")
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Question.node), SecondBrain.layer("2 seconds").pipe(Layer.provideMerge(Bus.layer))),
)

function receipt(project: string): SetupResult {
  return {
    action: "setup",
    project,
    attempt,
    status: "choice",
    configured: false,
    index: "unchecked",
    capture: "unavailable",
    question: {
      prompt: "Where should Raya keep your notes?",
      options: [
        { id: "use_prepared", label: "Suggested folder" },
        { id: "cancel", label: "Later" },
      ],
    },
  }
}

const pending = (brain: SecondBrain.Interface) =>
  pollWithTimeout(brain.list().pipe(Effect.map((rows) => rows[0])), "setup request did not arrive", "2 seconds")
const card = (question: Question.Interface) =>
  pollWithTimeout(question.list().pipe(Effect.map((rows) => rows[0])), "setup card did not arrive", "2 seconds")

test("setup accepts explicit personal requests and refuses preferences or action tails", () => {
  for (const text of [
    "Set up my personal memory.",
    "Connect my SecondBrain",
    "Please configure Memory for Raya.",
    "Can you please set up memory for me?",
    "Let's connect SecondBrain.",
  ])
    expect(requested(text)).toBe(true)
  for (const text of [
    "I prefer setup inside conversation.",
    "Set up my personal memory, then buy groceries",
    "Is Memory ready?",
  ])
    expect(requested(text)).toBe(false)
  expect(Schema.is(Setup)({ action: "setup", stage: "inspect" })).toBe(true)
  expect(Schema.is(Setup)({ action: "setup", stage: "continue", attempt, choice: "use_prepared" })).toBe(true)
  expect(Schema.is(Setup)({ action: "setup", stage: "continue", choice: "use_prepared" })).toBe(false)
})

test("setup receipts bind the original nonce and separate connection from verified recall", () => {
  const project = path.resolve("setup-project")
  const request: Request = {
    id: RequestID.make("setup"),
    sessionID: sid,
    project,
    command: { action: "setup", stage: "continue", attempt, choice: "use_prepared" },
  }
  const value = receipt(project)
  expect(valid(request, value)).toBe(true)
  expect(valid(request, { ...value, attempt: "b43ff5f0-6049-4009-905a-7649022ee5b8" })).toBe(false)
  expect(valid(request, { ...value, status: "configured", question: undefined })).toBe(false)
  expect(
    valid(request, {
      ...value,
      status: "configured",
      configured: true,
      root: path.resolve("notes"),
      question: undefined,
    }),
  ).toBe(true)
  expect(
    valid(request, {
      ...value,
      question: {
        ...value.question!,
        options: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      },
    }),
  ).toBe(false)
})

for (const outcome of ["select", "dismiss", "interrupt"] as const) {
  it.instance(`real Memory setup ${outcome} uses existing Question cards and preserves the original attempt`, () =>
    Effect.gen(function* () {
      const project = (yield* InstanceState.context).directory
      const brain = yield* SecondBrain.Service
      const question = yield* Question.Service
      const run = yield* setup({
        brain,
        question,
        project,
        ctx: {
          sessionID: sid,
          messageID: MessageID.make("msg_setup"),
          agent: "ask",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      }).pipe(Effect.forkChild)
      const first = yield* pending(brain)
      expect(first.command).toEqual({ action: "setup", stage: "inspect" })
      yield* brain.reply({ requestID: first.id, result: receipt(project) })
      const prompt = yield* card(question)
      expect(prompt.questions[0].options.map((option) => option.id)).toEqual([
        "raya-option:use_prepared",
        "raya-option:cancel",
      ])
      expect(prompt.autoSubmit).toBe(false)
      const stop = outcome === "interrupt" ? yield* Fiber.interrupt(run).pipe(Effect.forkChild) : undefined
      if (outcome === "dismiss") yield* question.reject(prompt.id)
      if (outcome === "select") yield* question.reply({ requestID: prompt.id, answers: [["raya-option:use_prepared"]] })
      const next = yield* pending(brain)
      expect(next.id).not.toBe(first.id)
      expect(next.command).toEqual(
        outcome === "select"
          ? { action: "setup", stage: "continue", attempt, choice: "use_prepared" }
          : { action: "setup", stage: "cancel", attempt },
      )
      yield* brain.reply({
        requestID: next.id,
        result: {
          ...receipt(project),
          status: outcome === "select" ? "configured" : "cancelled",
          question: undefined,
          ...(outcome === "select" ? { configured: true, root: path.resolve(project, "notes") } : {}),
        },
      })
      if (stop) yield* Fiber.join(stop)
      if (!stop) expect((yield* Fiber.join(run)).status).toBe(outcome === "select" ? "configured" : "cancelled")
      expect(yield* brain.list()).toEqual([])
      expect(yield* question.list()).toEqual([])
    }),
  )
}
