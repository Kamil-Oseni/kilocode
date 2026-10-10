import { expect, spyOn } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { BackgroundJob } from "@/background/job"
import { Storage } from "@/storage/storage"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import * as Lineage from "@/kilocode/task/effect-lineage"
import { SessionRetirement } from "@/kilocode/session/retirement"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Database.node,
      Storage.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      BackgroundJob.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

// Actual persisted Session evidence + actual acquired original execution owner.
// No positive SQL/native effect permission is fabricated by these fixtures.
const fixture = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const dir = (yield* TestInstance).directory
  const parent = yield* sessions.create({ title: "Original Routine owner" })
  const child = yield* sessions.create({ parentID: parent.id, title: "Actual delegated child" })
  const model = { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") }
  const user = MessageID.ascending()
  const message = MessageID.ascending()
  const input = MessageID.ascending()
  yield* sessions.updateMessage({
    id: user,
    sessionID: parent.id,
    role: "user",
    agent: "auto",
    model,
    time: { created: 1 },
  })
  yield* sessions.updateMessage({
    id: message,
    sessionID: parent.id,
    role: "assistant",
    parentID: user,
    agent: "auto",
    mode: "auto",
    providerID: model.providerID,
    modelID: model.modelID,
    cost: 0,
    path: { cwd: dir, root: dir },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 2 },
  })
  const part = {
    id: PartID.ascending(),
    sessionID: parent.id,
    messageID: message,
    type: "tool" as const,
    tool: "task",
    callID: "actual-task-owner",
    state: {
      status: "running" as const,
      input: { access: "read", brief: { objective: "Owned child work" } },
      title: "Owned child",
      metadata: { sessionId: child.id, childMessageID: input },
      time: { start: 2 },
    },
  }
  yield* sessions.updatePart(part)
  const identity = {
    sessionID: parent.id,
    messageID: message,
    callID: part.callID,
    childSessionID: child.id,
    childMessageID: input,
  }
  return {
    sessions,
    part,
    identity,
    parent,
    child,
    execution: RayaTaskExecution.make(yield* Storage.Service),
    owner: { id: crypto.randomUUID(), agentID: crypto.randomUUID(), sessionID: parent.id },
  }
})

it.instance("original root failure fences its actual delegated worker before cooperative cancellation and join", () =>
  Effect.gen(function* () {
    const value = yield* fixture
    const jobs = yield* BackgroundJob.Service
    const started = yield* Deferred.make<void>()
    const request = yield* Deferred.make<Lineage.Runner>()
    const events: string[] = []
    const exit = yield* value.execution
      .enter(
        value.owner,
        Effect.gen(function* () {
          const lease = yield* Lineage.admit(value.identity)
          if (!lease) throw new Error("Actual original child admission missing")
          const original = yield* Lineage.producer(
            lease,
            value.child.id,
            jobs.cancel(value.child.id).pipe(Effect.asVoid),
            true,
          )
          if (!original) throw new Error("Actual original producer missing")
          yield* jobs.start({
            id: value.child.id,
            type: "task",
            origin: value.identity,
            onFork: original.attach,
            onWork: original.worker,
            run: original
              .run(
                Effect.gen(function* () {
                  const runner = yield* Lineage.bind()
                  if (!runner) throw new Error("Actual child frame missing")
                  yield* Deferred.succeed(request, runner)
                  yield* Deferred.succeed(started, undefined)
                  return yield* Effect.never
                }),
              )
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    events.push("original child retired")
                  }),
                ),
              ),
          })
          yield* Deferred.await(started)
          return yield* Effect.fail(new Error("Original root failed"))
        }),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("Original root failed")
    expect((yield* jobs.get(value.child.id))?.status).toBe("cancelled")
    expect(events).toEqual(["original child retired"])
    const runner = yield* Deferred.await(request)
    const late = yield* Effect.promise(() =>
      Lineage.run(runner, async () => {
        events.push("late dispatch")
      }),
    ).pipe(Effect.exit)
    expect(Exit.isFailure(late)).toBe(true)
    expect(events).toEqual(["original child retired"])
    yield* value.execution.finish(value.owner)
  }),
)

it.instance(
  "saved Task rows cannot mint a child lease and genuine leases reject clones, foreign children and substituted input",
  () =>
    Effect.gen(function* () {
      const value = yield* fixture
      expect(yield* Lineage.admit(value.identity)).toBeUndefined()
      const exit = yield* value.execution
        .enter(
          value.owner,
          Effect.gen(function* () {
            const lease = yield* Lineage.admit(value.identity)
            if (!lease) throw new Error("Actual original child admission missing")
            const clone = yield* Lineage.producer(structuredClone(lease), value.child.id, Effect.void).pipe(Effect.exit)
            expect(Exit.isFailure(clone)).toBe(true)
            const foreign = yield* value.sessions.create({ title: "Foreign child" })
            expect(Exit.isFailure(yield* Lineage.producer(lease, foreign.id, Effect.void).pipe(Effect.exit))).toBe(true)
            const original = yield* Lineage.producer(lease, value.child.id, Effect.void)
            if (!original) throw new Error("Actual original producer missing")
            yield* value.sessions.updatePart({
              ...value.part,
              state: { ...value.part.state, input: { access: "edit" } },
            })
            const child = yield* original.run(Effect.succeed("must not run")).pipe(
              Effect.exit,
              Effect.tap((substituted) => Effect.sync(() => expect(Exit.isFailure(substituted)).toBe(true))),
              Effect.asVoid,
              Effect.forkChild,
            )
            yield* original.attach(child)
            yield* Fiber.join(child)
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* value.execution.finish(value.owner)
    }),
)

it.instance("stop during successful root draining retires the child frame and joins its actual worker", () =>
  Effect.gen(function* () {
    const value = yield* fixture
    const jobs = yield* BackgroundJob.Service
    const returned = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const request = yield* Deferred.make<Lineage.Runner>()
    const events: string[] = []
    const root = yield* value.execution
      .enter(
        value.owner,
        Effect.gen(function* () {
          const lease = yield* Lineage.admit(value.identity)
          if (!lease) throw new Error("Actual original child admission missing")
          const original = yield* Lineage.producer(
            lease,
            value.child.id,
            jobs.cancel(value.child.id).pipe(Effect.asVoid),
            true,
          )
          if (!original) throw new Error("Actual original producer missing")
          yield* jobs.start({
            id: value.child.id,
            type: "task",
            origin: value.identity,
            onFork: original.attach,
            onWork: original.worker,
            run: original
              .run(
                Effect.gen(function* () {
                  const runner = yield* Lineage.bind()
                  if (!runner) throw new Error("Actual child frame missing")
                  yield* Deferred.succeed(request, runner)
                  yield* Deferred.succeed(started, undefined)
                  return yield* Effect.never
                }),
              )
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    events.push("original child retired")
                  }),
                ),
              ),
          })
          return "Original parent prompt returned"
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Deferred.succeed(returned, undefined).pipe(
                  // Default-lazy dispatch runs after the successful body observer
                  // returns and original ownership starts awaiting its real child.
                  Effect.forkDetach,
                  Effect.asVoid,
                )
              : Effect.void,
          ),
        ),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(returned)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(root)
    const exit = yield* Fiber.await(root)
    const status = (yield* jobs.get(value.child.id))?.status
    expect(Exit.isFailure(exit)).toBe(true)
    expect(status).toBe("cancelled")
    expect(events).toEqual(["original child retired"])
    const runner = yield* Deferred.await(request)
    expect(
      Exit.isFailure(
        yield* Effect.promise(() =>
          Lineage.run(runner, async () => {
            events.push("late dispatch")
          }),
        ).pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(events).toEqual(["original child retired"])
    yield* value.execution.finish(value.owner)
  }),
)

it.instance("retiring an attached original before onWork cancels and joins its real inner worker", () =>
  Effect.gen(function* () {
    const value = yield* fixture
    const jobs = yield* BackgroundJob.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const stopping = yield* Deferred.make<void>()
    const events: string[] = []
    const root = yield* value.execution
      .enter(
        value.owner,
        Effect.gen(function* () {
          const lease = yield* Lineage.admit(value.identity)
          if (!lease) throw new Error("Actual original admission missing")
          // Observe the real root's cancellation request before releasing the actual
          // onWork callback. Its late attachment must signal the Core control itself.
          const original = yield* Lineage.producer(lease, value.child.id, Deferred.succeed(stopping, undefined), true)
          if (!original) throw new Error("Actual original producer missing")
          yield* jobs.start({
            id: value.child.id,
            type: "task",
            origin: value.identity,
            onFork: original.attach,
            onWork: (fiber, request) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(original.worker(fiber, request)),
              ),
            run: original.run(
              Effect.sync(() => {
                events.push("must not execute retired work")
                return "unreachable"
              }),
            ),
          })
          yield* Deferred.await(entered)
          return yield* Effect.fail(new Error("Original retired before inner work attachment"))
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(stopping)
    const blocked = [...events]
    yield* Deferred.succeed(release, undefined)
    const exit = yield* Fiber.await(root)
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("Original retired before inner work attachment")
    expect((yield* jobs.get(value.child.id))?.status).toBe("cancelled")
    expect(blocked).toEqual([])
    expect(events).toEqual([])
    yield* value.execution.finish(value.owner)
  }),
)

it.instance("a real existing running job does not leave an unstarted original launch reserved", () =>
  Effect.gen(function* () {
    const value = yield* fixture
    const jobs = yield* BackgroundJob.Service
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const returned = yield* Deferred.make<Fiber.Fiber<void, unknown>>()
    const events: string[] = []
    const existing = yield* jobs.start({
      id: value.child.id,
      type: "task",
      onFork: (fiber) => Deferred.succeed(returned, fiber),
      run: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("Existing original finished"),
        Effect.ensuring(Effect.sync(() => events.push("existing joined"))),
      ),
    })
    yield* Deferred.await(started)
    const result = yield* value.execution.enter(
      value.owner,
      Effect.gen(function* () {
        const lease = yield* Lineage.admit(value.identity)
        if (!lease) throw new Error("Actual original admission missing")
        return yield* Lineage.launch(lease, value.child.id, (original) => {
          if (!original) throw new Error("Actual original launch missing")
          return jobs.start({
            id: value.child.id,
            type: "task",
            origin: value.identity,
            onFork: original.attach,
            onWork: original.worker,
            run: original.run(
              Effect.sync(() => {
                events.push("must not substitute existing job")
                return "unreachable"
              }),
            ),
          })
        })
      }),
    )
    expect(result?.revision).toBe(existing.revision)
    expect((yield* jobs.get(value.child.id))?.status).toBe("running")
    expect(events).toEqual([])
    yield* Deferred.succeed(release, undefined)
    const joined = yield* Fiber.await(yield* Deferred.await(returned))
    const settled = yield* jobs.get(value.child.id)
    // Observe the actual outer Exit without throwing before the terminal-state
    // oracle. A failure here remains a failure; no cancelled join is called success.
    expect(settled?.status).toBe("completed")
    expect(settled?.output).toBe("Existing original finished")
    expect(Exit.isSuccess(joined)).toBe(true)
    expect(events).toEqual(["existing joined"])
    yield* value.execution.finish(value.owner)
  }),
)

it.instance("owned lazy retirement children settle their original tickets even under a masked caller", () =>
  Effect.gen(function* () {
    for (const kind of ["fork", "child", "scoped"] as const) {
      const port = SessionRetirement.make()
      const scope = yield* Scope.make()
      yield* Effect.gen(function* () {
        const fiber = yield* Effect.uninterruptible(
          kind === "fork"
            ? port.fork(() => Effect.never)
            : kind === "child"
              ? port.child(Effect.never)
              : port.scoped(Effect.never, scope, Effect.failCause),
        )
        yield* port.interrupt(fiber)
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(port.snapshot()).toEqual({
          closing: false,
          active: 0,
          accepted: 1,
          settled: 1,
          failures: 0,
          cancelled: 1,
        })
        yield* port.drain
      }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
    }
    const port = SessionRetirement.make()
    const scope = yield* Scope.make()
    yield* Scope.close(scope, Exit.void)
    const events: string[] = []
    const fiber = yield* port.scoped(
      Effect.sync(() => events.push("must not enter closed scope")),
      scope,
      Effect.failCause,
    )
    expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
    expect(events).toEqual([])
    expect(port.snapshot().active).toBe(0)
    expect(port.snapshot().settled).toBe(1)
  }),
)

it.instance("retirement during notification attachment cleans up only its actual returned producer fiber", () =>
  Effect.gen(function* () {
    const value = yield* fixture
    const scope = yield* Scope.make()
    const release = yield* Deferred.make<void>()
    const returned = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
    const notification = yield* Deferred.make<Fiber.Fiber<void, unknown>>()
    const unrelated = yield* Deferred.make<void>()
    const foreign = yield* SessionRetirement.scoped(Deferred.await(unrelated), scope, Effect.failCause)
    const before = SessionRetirement.snapshot().active ?? 0
    const events: string[] = []
    const delegate = SessionRetirement.scoped
    // Transparent fault observer: the real module reserves/forks its real Fiber.
    // Holding only its return exposes retirement before Lineage's attachment.
    const delayed: typeof delegate = (body, scope, fallback) =>
      delegate(body, scope, fallback).pipe(
        Effect.tap((fiber) => Deferred.succeed(returned, fiber).pipe(Effect.andThen(Deferred.await(release)))),
      )
    const spy = spyOn(SessionRetirement, "scoped").mockImplementation(delayed)
    yield* Effect.gen(function* () {
      const exit = yield* value.execution
        .enter(
          value.owner,
          Effect.gen(function* () {
            const lease = yield* Lineage.admit(value.identity)
            if (!lease) throw new Error("Actual original admission missing")
            const delivery = yield* Lineage.scoped(
              lease,
              value.parent.id,
              Effect.sync(() => {
                events.push("must not deliver retired notice")
              }),
              scope,
              Effect.failCause,
            ).pipe(Effect.asVoid, Effect.forkDetach)
            yield* Deferred.succeed(notification, delivery)
            yield* Deferred.await(returned)
            return yield* Effect.fail(new Error("Original retired during notification attachment"))
          }),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "Original retired during notification attachment",
      )
      yield* Deferred.succeed(release, undefined)
      const delivery = yield* Fiber.await(yield* Deferred.await(notification))
      expect(Exit.isFailure(delivery) && Cause.pretty(delivery.cause)).toContain("Original routine execution lineage")
      const actual = yield* Fiber.await(yield* Deferred.await(returned))
      expect(Exit.isFailure(actual)).toBe(true)
      expect(SessionRetirement.snapshot().active ?? 0).toBe(before)
      expect(foreign.pollUnsafe()).toBeUndefined()
      expect(events).toEqual([])
      yield* Deferred.succeed(unrelated, undefined)
      yield* Fiber.join(foreign)
      yield* value.execution.finish(value.owner)
    }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())), Effect.ensuring(Scope.close(scope, Exit.void)))
  }),
)
