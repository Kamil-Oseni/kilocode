import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Config } from "../../src/config/config"

const events = AppNodeBuilder.build(EventV2Bridge.node)
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  AppNodeBuilder.build(Permission.node),
  events,
  AppNodeBuilder.build(CrossSpawnSpawner.node),
  AppNodeBuilder.build(InstanceStore.node, [[InstanceStore.bootstrapNode, noopBootstrap]]),
).pipe(Layer.provide(RuntimeFlags.layer()), Layer.provideMerge(AppNodeBuilder.build(Config.node)))
const it = testEffect(Layer.mergeAll(env, RuntimeFlags.layer()))

const pending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  for (const _ of Array.from({ length: 200 })) {
    const list = yield* permission.list()
    if (list.length) return list[0]
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Permission did not become pending")
})
const wanted = (pattern: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const _ of Array.from({ length: 200 })) {
      const match = (yield* permission.list()).find((item) => item.patterns.includes(pattern))
      if (match) return match
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("Permission did not become pending")
  })
const setup = Effect.gen(function* () {
  const cfg = yield* Config.Service
  const permission = yield* Permission.Service
  yield* cfg.updateGlobal({ permission: { bash: "ask" } })
  const initial = yield* cfg.get()
  const input = {
    sessionID: SessionID.make("session_policy_test"),
    permission: "bash",
    patterns: ["echo synthetic"],
    metadata: {},
    always: ["echo *"],
    ruleset: Permission.fromConfig(initial.permission ?? {}),
  }
  const dispatched: boolean[] = []
  const fiber = yield* permission.ask(input).pipe(
    Effect.tap(() => Effect.sync(() => dispatched.push(true))),
    Effect.forkScoped,
  )
  const request = yield* pending
  return { cfg, permission, input, dispatched, fiber, request }
})
for (const options of [undefined, { dispose: false }]) {
  it.instance(
    `rejects pending approval after persisted deny (${JSON.stringify(options)})`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup
        expect((yield* state.cfg.updateGlobal({ permission: { bash: "deny" } }, options)).changed).toBe(true)
        const rules = Permission.fromConfig((yield* state.cfg.get()).permission ?? {})
        expect(Permission.resolve("bash", "echo synthetic", rules).action).toBe("deny")
        expect(Exit.isFailure(yield* state.permission.ask({ ...state.input, ruleset: rules }).pipe(Effect.exit))).toBe(
          true,
        )
        yield* state.permission.reply({ requestID: state.request.id, reply: "once" })
        expect(Exit.isFailure(yield* Fiber.await(state.fiber))).toBe(true)
        expect(state.dispatched).toEqual([])
      }),
    { git: true },
    30000,
  )
}
for (const reply of ["once", "always"] as const) {
  it.instance(
    `unchanged ${reply} approval still releases exactly once`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup
        yield* state.permission.reply({ requestID: state.request.id, reply })
        expect(Exit.isSuccess(yield* Fiber.await(state.fiber))).toBe(true)
        expect(state.dispatched).toEqual([true])
      }),
    { git: true },
    30000,
  )
}
it.instance(
  "selected saved allow rules remain valid for their explicit pending reply",
  () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.permission.saveAlwaysRules({ requestID: state.request.id, approvedAlways: ["echo *"] })
      yield* state.permission.reply({ requestID: state.request.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(state.fiber))).toBe(true)
      expect(state.dispatched).toEqual([true])
    }),
  { git: true },
  30000,
)
it.instance(
  "policy changed during actual reply publication cannot release work",
  () =>
    Effect.gen(function* () {
      const state = yield* setup
      const events = yield* EventV2Bridge.Service
      let changed = false
      const unsubscribe = yield* events.listen((event) => {
        if (
          changed ||
          event.type !== Permission.Event.Replied.type ||
          !event.data ||
          typeof event.data !== "object" ||
          !("reply" in event.data) ||
          event.data.reply === "reject"
        )
          return Effect.void
        changed = true
        return state.cfg.updateGlobal({ permission: { bash: "deny" } }).pipe(Effect.asVoid)
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* state.permission.reply({ requestID: state.request.id, reply: "once" })
      expect(changed).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(state.fiber))).toBe(true)
      expect(state.dispatched).toEqual([])
    }),
  { git: true },
  30000,
)
for (const action of ["saved", "everything"] as const) {
  it.instance(
    `stale policy cannot escape through ${action} release`,
    () =>
      Effect.gen(function* () {
        const state = yield* setup
        yield* state.cfg.updateGlobal({ permission: { bash: "deny" } })
        if (action === "saved")
          yield* state.permission.saveAlwaysRules({ requestID: state.request.id, approvedAlways: ["echo *"] })
        if (action === "everything")
          yield* state.permission.allowEverything({ enable: true, sessionID: state.input.sessionID })
        expect(Exit.isFailure(yield* Fiber.await(state.fiber))).toBe(true)
        expect(state.dispatched).toEqual([])
      }),
    { git: true },
    30000,
  )
}
it.instance(
  "unrelated display settings do not invalidate a pending approval",
  () =>
    Effect.gen(function* () {
      const state = yield* setup
      expect((yield* state.cfg.updateGlobal({ username: "policy-fixture" })).changed).toBe(true)
      yield* state.permission.reply({ requestID: state.request.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(state.fiber))).toBe(true)
      expect(state.dispatched).toEqual([true])
    }),
  { git: true },
  30000,
)
it.instance(
  "restrictive update after saved allow cannot release work",
  () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.permission.saveAlwaysRules({ requestID: state.request.id, approvedAlways: ["echo *"] })
      expect((yield* state.cfg.updateGlobal({ permission: { bash: "deny" } })).changed).toBe(true)
      yield* state.permission.reply({ requestID: state.request.id, reply: "once" })
      expect(Exit.isFailure(yield* Fiber.await(state.fiber))).toBe(true)
      expect(state.dispatched).toEqual([])
    }),
  { git: true },
  30000,
)
it.instance(
  "late approval after cancellation cannot dispatch work",
  () =>
    Effect.gen(function* () {
      const state = yield* setup
      yield* state.permission.reply({ requestID: state.request.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(state.fiber))).toBe(true)
      expect(state.dispatched).toEqual([])
      expect(
        Exit.isFailure(yield* state.permission.reply({ requestID: state.request.id, reply: "once" }).pipe(Effect.exit)),
      ).toBe(true)
      expect(state.dispatched).toEqual([])
    }),
  { git: true },
  30000,
)
it.instance(
  "saved deny drains a covered sibling without releasing the originating request",
  () =>
    Effect.gen(function* () {
      const cfg = yield* Config.Service
      const permission = yield* Permission.Service
      yield* cfg.updateGlobal({ permission: { bash: "ask" } })
      const input = {
        sessionID: SessionID.make("session_policy_deny"),
        permission: "bash",
        patterns: ["rm synthetic"],
        metadata: {},
        always: ["rm *"],
        ruleset: Permission.fromConfig((yield* cfg.get()).permission ?? {}),
      }
      const dispatched: boolean[] = []
      const extra: boolean[] = []
      const origin = yield* permission.ask(input).pipe(
        Effect.tap(() => Effect.sync(() => dispatched.push(true))),
        Effect.forkScoped,
      )
      const first = yield* wanted("rm synthetic")
      const fiber = yield* permission
        .ask({
          ...input,
          sessionID: SessionID.make("session_policy_sibling"),
          patterns: ["rm other"],
        })
        .pipe(
          Effect.tap(() => Effect.sync(() => extra.push(true))),
          Effect.forkScoped,
        )
      yield* wanted("rm other")
      yield* permission.saveAlwaysRules({ requestID: first.id, deniedAlways: ["rm *"] })
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(extra).toEqual([])
      yield* permission.reply({ requestID: first.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(origin))).toBe(true)
      expect(dispatched).toEqual([true])
    }),
  { git: true },
  30000,
)
