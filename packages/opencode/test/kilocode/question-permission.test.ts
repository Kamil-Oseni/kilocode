import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Queue } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { MessageID, SessionID } from "@/session/schema"
import { QuestionTool } from "@/tool/question"
import { AskOptionsTool } from "@/kilocode/tool/ask-options"
import { Truncate } from "@/tool/truncate"
import type * as Tool from "@/tool/tool"
import { testEffect } from "../lib/effect"
import type { Config } from "@/config/config"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, Permission.node, EventV2Bridge.node, Truncate.node, Agent.node])),
)
const questions = [
  { question: "Disposable choice", header: "Fixture", options: [{ label: "Yes", description: "Proceed" }] },
]
const options = [
  {
    prompt: "Disposable choice",
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },
]

const policies: { name: string; allowed: boolean; config: Partial<Config.Info> }[] = [
  {
    name: "wildcard denial",
    allowed: false,
    config: { permission: { "*": "deny", chief_route: "allow", task: "allow" } },
  },
  {
    name: "explicit global allow",
    allowed: true,
    config: { permission: { "*": "deny", question: "allow", ask_options: "allow" } },
  },
  {
    name: "explicit Auto allow",
    allowed: true,
    config: {
      permission: { "*": "deny" },
      agent: { auto: { permission: { question: "allow", ask_options: "allow" } } },
    },
  },
  {
    name: "explicit Auto denial",
    allowed: false,
    config: {
      permission: { question: "allow", ask_options: "allow" },
      agent: { auto: { permission: { question: "deny", ask_options: "deny" } } },
    },
  },
]

for (const policy of policies)
  for (const kind of ["question", "ask_options"] as const)
    it.instance(
      `Auto ${policy.name} controls actual ${kind} publication`,
      () =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const permission = yield* Permission.Service
          const question = yield* Question.Service
          const events = yield* EventV2Bridge.Service
          const agent = yield* agents.get("auto")
          if (!agent) throw new Error("Actual Auto agent required")
          const id = SessionID.make("ses_auto_config_question")
          const published = yield* Queue.unbounded<void>()
          const off = yield* events.listen((event) => {
            if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(published, undefined)
            return Effect.void
          })
          yield* Effect.addFinalizer(() => off)
          yield* Effect.addFinalizer(() => question.dismissAll(id))
          const ctx = {
            sessionID: id,
            messageID: MessageID.make("msg_auto_config_question"),
            agent: "auto",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
              permission
                .ask({ ...request, sessionID: id, ruleset: agent.permission })
                .pipe(Effect.asVoid, Effect.orDie),
          }
          const operation =
            kind === "question"
              ? (yield* (yield* QuestionTool).init()).execute({ questions }, ctx).pipe(Effect.asVoid)
              : (yield* (yield* AskOptionsTool).init()).execute({ questions: options }, ctx).pipe(Effect.asVoid)
          const original = yield* operation.pipe(Effect.exit, Effect.forkScoped)
          const visible = yield* Effect.raceFirst(
            Queue.take(published).pipe(Effect.as(true)),
            Fiber.await(original).pipe(Effect.as(false)),
          ).pipe(Effect.timeout("2 seconds"))
          if (visible) {
            const pending = (yield* question.list())[0]
            yield* question.reply({
              requestID: pending.id,
              answers: [[kind === "question" ? "Yes" : "raya-option:yes"]],
            })
          }
          const result = yield* Fiber.join(original)
          expect(visible).toBe(policy.allowed)
          expect(Exit.isSuccess(result)).toBe(policy.allowed)
          if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(Permission.DeniedError)
          expect(yield* question.list()).toHaveLength(0)
          expect(yield* permission.list()).toHaveLength(0)
        }),
      { config: policy.config },
    )

for (const kind of ["question", "ask_options"] as const) {
  for (const denied of kind === "question" ? ["question"] : ["question", "ask_options"]) {
    it.instance(`${kind} refuses ${denied} denial before Question publication`, () =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const question = yield* Question.Service
        const events = yield* EventV2Bridge.Service
        const published = yield* Queue.unbounded<void>()
        const off = yield* events.listen((event) => {
          if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(published, undefined)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)
        const ctx = {
          sessionID: SessionID.make("ses_question_denial"),
          messageID: MessageID.make("msg_question_denial"),
          agent: "auto",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
            permission
              .ask({
                ...request,
                sessionID: SessionID.make("ses_question_denial"),
                ruleset: Permission.fromConfig({ question: "allow", ask_options: "allow", [denied]: "deny" }),
              })
              .pipe(Effect.asVoid, Effect.orDie),
        }
        const result =
          kind === "question"
            ? yield* (yield* (yield* QuestionTool).init()).execute({ questions }, ctx).pipe(Effect.asVoid, Effect.exit)
            : yield* (yield* (yield* AskOptionsTool).init())
                .execute({ questions: options }, ctx)
                .pipe(Effect.asVoid, Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(Permission.DeniedError)
        expect(yield* question.list()).toHaveLength(0)
        expect(yield* Queue.size(published)).toBe(0)
      }),
    )
  }
  it.instance(`${kind} allowed permission retains actual Question reply`, () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const agents = yield* Agent.Service
      const agent = yield* agents.get("auto")
      expect(agent).toBeDefined()
      const events = yield* EventV2Bridge.Service
      const published = yield* Queue.unbounded<void>()
      const approvals = yield* Queue.unbounded<void>()
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(published, undefined)
        if (event.type === Permission.Event.Asked.type) Queue.offerUnsafe(approvals, undefined)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)
      const ctx = {
        sessionID: SessionID.make("ses_question_allowed"),
        messageID: MessageID.make("msg_question_allowed"),
        agent: "auto",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (request: Parameters<Tool.Context["ask"]>[0]) =>
          permission
            .ask({
              ...request,
              sessionID: SessionID.make("ses_question_allowed"),
              ruleset: agent?.permission ?? [],
            })
            .pipe(Effect.asVoid, Effect.orDie),
      }
      const operation =
        kind === "question"
          ? (yield* (yield* QuestionTool).init()).execute({ questions }, ctx)
          : (yield* (yield* AskOptionsTool).init()).execute({ questions: options }, ctx)
      const original = yield* operation.pipe(Effect.forkScoped)
      yield* Queue.take(published).pipe(Effect.timeout("2 seconds"))
      const pending = (yield* question.list())[0]
      yield* question.reply({ requestID: pending.id, answers: [[kind === "question" ? "Yes" : "raya-option:yes"]] })
      const result = yield* Fiber.join(original)
      expect(result.title).toBe("Asked 1 question")
      expect(yield* question.list()).toHaveLength(0)
      expect(yield* permission.list()).toHaveLength(0)
      expect(yield* Queue.size(approvals)).toBe(0)
    }),
  )
}
