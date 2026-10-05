import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Question } from "@/question"
import { SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node])))

it.instance("interruption while Asked publication is held closes the original pending entry", () =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const events = yield* EventV2Bridge.Service
    const entered = yield* Deferred.make<void>()
    const held = yield* Deferred.make<void>()
    const off = yield* events.listen((event) =>
      event.type === Question.Event.Asked.type
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held)))
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => off)
    const original = yield* question
      .ask({
        sessionID: SessionID.make("ses_publication_stop"),
        questions: [{ question: "Disposable question", header: "Fixture", options: [] }],
      })
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    expect(yield* question.list()).toHaveLength(1)
    yield* Fiber.interrupt(original)
    const terminal = yield* Fiber.await(original)
    expect(Exit.isFailure(terminal)).toBe(true)
    expect(yield* question.list()).toHaveLength(0)
  }),
)
