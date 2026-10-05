import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Question } from "@/question"
import { SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionRetirement } from "@/kilocode/session/retirement"
import { admission } from "@/kilocode/task/admission"
import { retire, serveShutdown } from "@/kilocode/cli/serve-shutdown"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node])))

for (const defect of [false, true]) {
  it.instance(`shutdown joins actual pending Question and original cleanup${defect ? " defect" : ""}`, () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const controller = SessionRetirement.make()
      const scheduled = admission()
      const asked = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const off = yield* events.listen((event) =>
        event.type === Question.Event.Asked.type ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid) : Effect.void,
      )
      yield* Effect.addFinalizer(() => off)
      const original = yield* scheduled.fork(
        Effect.succeed(
          controller.run(() =>
            question
              .ask({
                sessionID: SessionID.make("ses_shutdown_question"),
                questions: [{ question: "Synthetic pending question", header: "Fixture", options: [] }],
              })
              .pipe(
                Effect.ensuring(
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(defect ? Effect.die(new Error("original cleanup defect")) : Effect.void),
                  ),
                ),
              ),
          ),
        ),
        () => new Error("scheduler intake refused"),
      )
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(release, undefined).pipe(
          Effect.andThen(controller.stop.pipe(Effect.exit)),
          Effect.andThen(Fiber.await(original)),
        ),
      )
      yield* Deferred.await(asked)
      expect(yield* question.list()).toHaveLength(1)
      const marks: string[] = []
      const shutdown = serveShutdown({
        signals: new EventEmitter(),
        watchdog: () => {
          marks.push("watchdog")
        },
        admission: () =>
          retire({
            source: async () => {
              marks.push("source")
            },
            requests: async () => {
              marks.push("http")
            },
            scheduled: scheduled.quiesce,
            stop: () => Effect.runPromise(controller.stop),
          }),
        tasks: [
          () => {
            marks.push("storage-disposal")
          },
        ],
      })
      const waiting = yield* Effect.promise(() =>
        shutdown.wait.then(
          () => Exit.void,
          (err) => Exit.die(err),
        ),
      ).pipe(Effect.forkScoped)
      const closing = yield* Effect.promise(() => shutdown.run()).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(entered)
      expect(yield* question.list()).toHaveLength(0)
      expect(scheduled.snapshot().closed).toBe(true)
      expect(scheduled.snapshot().active).toBe(1)
      expect(controller.snapshot().closing).toBe(true)
      expect(controller.snapshot().active).toBe(1)
      expect(marks).toEqual(["watchdog", "source", "http"])
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const terminal = yield* Fiber.join(closing)
      const held = yield* Fiber.await(original)
      const observed = yield* Fiber.join(waiting)
      expect(Exit.isFailure(terminal)).toBe(true)
      expect(Exit.isFailure(observed)).toBe(true)
      expect(Exit.isFailure(held)).toBe(true)
      expect(controller.snapshot().active).toBe(0)
      expect(scheduled.snapshot().active).toBe(0)
      expect(scheduled.snapshot().failures).toBe(1)
      expect(controller.snapshot().failures).toBe(defect ? 1 : 0)
      expect(controller.snapshot().cancelled).toBe(defect ? 0 : 1)
      expect(marks).toEqual(["watchdog", "source", "http", "storage-disposal"])
      if (Exit.isFailure(held) && defect) expect(Cause.pretty(held.cause)).toContain("original cleanup defect")
      expect(yield* question.list()).toHaveLength(0)
    }),
  )
}

test("stop retains unrelated original interruption instead of authorizing it retrospectively", async () => {
  const controller = SessionRetirement.make()
  const entered = Deferred.makeUnsafe<void>()
  const original = await Effect.runPromise(
    controller.fork(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
  )
  await Effect.runPromise(Deferred.await(entered))
  await Effect.runPromise(Fiber.interrupt(original))
  const terminal = await Effect.runPromise(Effect.exit(controller.stop))
  expect(Exit.isFailure(terminal)).toBe(true)
  expect(controller.snapshot().active).toBe(0)
  expect(controller.snapshot().failures).toBe(1)
  expect(controller.snapshot().cancelled).toBe(0)
})

test("stop cancels a reserved child before its first body instruction", async () => {
  const controller = SessionRetirement.make()
  const scope = await Effect.runPromise(Scope.make())
  const marks: string[] = []
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const original = yield* controller.scoped(
          Effect.sync(() => {
            marks.push("body")
          }),
          scope,
          Effect.failCause,
        )
        yield* controller.stop
        const terminal = yield* Fiber.await(original)
        expect(Exit.isFailure(terminal)).toBe(true)
        expect(marks).toEqual([])
        expect(controller.snapshot().active).toBe(0)
        expect(controller.snapshot().failures).toBe(0)
        expect(controller.snapshot().cancelled).toBe(1)
      }),
    )
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
