import { afterEach, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { ChildSteerPath } from "@/kilocode/server/httpapi/groups/child-steer"
import { Server } from "@/server/server"
import { SessionRunState } from "@/session/run-state"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { disposeAllInstances, reloadTestInstance, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { pollWithTimeout } from "../../lib/effect"
import { withTimeout } from "@/util/timeout"

void Log.init({ print: false })

const prior = { flag: Flag.KILO_SERVER_PASSWORD, env: process.env.KILO_SERVER_PASSWORD }

afterEach(async () => {
  Flag.KILO_SERVER_PASSWORD = prior.flag
  if (prior.env === undefined) delete process.env.KILO_SERVER_PASSWORD
  else process.env.KILO_SERVER_PASSWORD = prior.env
  await disposeAllInstances()
  await resetDatabase()
})

test("child steer is direct, active, routed, and replay-safe", async () => {
  Flag.KILO_SERVER_PASSWORD = undefined
  delete process.env.KILO_SERVER_PASSWORD
  await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  await using other = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  const ctx = await reloadTestInstance({ directory: tmp.path })
  const otherCtx = await reloadTestInstance({ directory: other.path })
  const tree = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const wrong = yield* sessions.create({ title: "wrong parent" })
      const model = { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("saved-child-model") }
      const child = yield* sessions.create({ title: "child", parentID: parent.id, agent: "ask", model })
      const sibling = yield* sessions.create({ title: "sibling", parentID: parent.id })
      const nested = yield* sessions.create({ title: "nested", parentID: child.id })
      const invalid = yield* sessions.create({
        title: "invalid",
        parentID: parent.id,
        agent: "missing-child-agent",
        model,
      })
      const stale = yield* sessions.create({ title: "stale", parentID: parent.id })
      return { parent, wrong, child, sibling, nested, invalid, stale }
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )
  const foreign = await AppRuntime.runPromise(
    Session.Service.use((sessions) => sessions.create({ title: "foreign child", parentID: tree.parent.id })).pipe(
      Effect.provideService(InstanceRef, otherCtx),
    ),
  )
  const started = Promise.withResolvers<void>()
  const invalidStarted = Promise.withResolvers<void>()
  const running = AppRuntime.runPromise(
    SessionRunState.Service.use((runs) =>
      runs.ensureRunning(
        tree.child.id,
        Effect.interrupt,
        Effect.sync(started.resolve).pipe(Effect.andThen(Effect.never)),
      ),
    ).pipe(Effect.provideService(InstanceRef, ctx)),
  ).catch(() => undefined)
  const invalidRunning = AppRuntime.runPromise(
    SessionRunState.Service.use((runs) =>
      runs.ensureRunning(
        tree.invalid.id,
        Effect.interrupt,
        Effect.sync(invalidStarted.resolve).pipe(Effect.andThen(Effect.never)),
      ),
    ).pipe(Effect.provideService(InstanceRef, ctx)),
  ).catch(() => undefined)
  const staleStarted = Promise.withResolvers<void>()
  const staleRunning = AppRuntime.runPromise(
    SessionRunState.Service.use((runs) =>
      runs.ensureRunning(
        tree.stale.id,
        Effect.interrupt,
        Effect.sync(staleStarted.resolve).pipe(Effect.andThen(Effect.never)),
      ),
    ).pipe(Effect.provideService(InstanceRef, ctx)),
  ).catch(() => undefined)
  const route = (parent: SessionID, child: SessionID) =>
    ChildSteerPath.replace(":parentSessionID", parent).replace(":childSessionID", child)
  const call = (base: URL, parent: SessionID, child: SessionID, messageID: string, text: string, dir = tmp.path) =>
    fetch(new URL(`${route(parent, child)}?directory=${encodeURIComponent(dir)}`, base), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kilo-directory": dir },
      body: JSON.stringify({ messageID, text }),
    })

  await Promise.all([
    withTimeout(started.promise, 5_000, "timed out starting child run"),
    withTimeout(invalidStarted.promise, 5_000, "timed out starting invalid child run"),
    withTimeout(staleStarted.promise, 5_000, "timed out starting stale child run"),
  ])
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const empty = await call(listener.url, tree.parent.id, tree.child.id, MessageID.ascending(), "   ")
    expect(empty.status).toBe(400)
    const oversized = await call(listener.url, tree.parent.id, tree.child.id, MessageID.ascending(), "x".repeat(32_001))
    expect(oversized.status).toBe(400)

    const id = MessageID.ascending()
    const accepted = await call(listener.url, tree.parent.id, tree.child.id, id, "Inspect only the parser")
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({
      parentSessionID: tree.parent.id,
      childSessionID: tree.child.id,
      messageID: id,
      replayed: false,
    })
    await AppRuntime.runPromise(
      pollWithTimeout(
        Session.Service.use((sessions) =>
          sessions
            .findMessage(tree.child.id, (message) => message.info.id === id)
            .pipe(Effect.map(Option.getOrUndefined)),
        ),
        "timed out waiting for child steering admission",
        "5 seconds",
      ).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    const delivered = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const child = yield* sessions.findMessage(tree.child.id, (message) => message.info.id === id)
        const parent = yield* sessions.findMessage(tree.parent.id, (message) => message.info.id === id)
        return { child: Option.getOrUndefined(child), parent: Option.getOrUndefined(parent) }
      }).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    expect(delivered.parent).toBeUndefined()
    expect(delivered.child?.info).toMatchObject({
      id,
      sessionID: tree.child.id,
      agent: "ask",
      model: { providerID: "test", modelID: "saved-child-model" },
    })
    expect(delivered.child?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Inspect only the parser", messageID: id }),
    ])

    const replay = await call(listener.url, tree.parent.id, tree.child.id, id, "Inspect only the parser")
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ messageID: id, replayed: true })
    const changed = await call(listener.url, tree.parent.id, tree.child.id, id, "Change the parser")
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ code: "changed-replay" })

    const concurrentID = MessageID.ascending()
    const concurrent = await Promise.all([
      call(listener.url, tree.parent.id, tree.child.id, concurrentID, "Keep the exact scope"),
      call(listener.url, tree.parent.id, tree.child.id, concurrentID, "Keep the exact scope"),
      call(listener.url, tree.parent.id, tree.child.id, concurrentID, "Expand the scope"),
    ])
    expect(concurrent.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 200, 409])
    const admitted = await Promise.all(
      concurrent.filter((response) => response.status === 200).map((response) => response.json()),
    )
    expect(admitted.map((item) => item.replayed).sort((a, b) => Number(a) - Number(b))).toEqual([false, true])
    const conflict = concurrent.find((response) => response.status === 409)!
    expect(await conflict.json()).toMatchObject({ code: "changed-replay" })

    const failedID = MessageID.ascending()
    const failed = await call(listener.url, tree.parent.id, tree.invalid.id, failedID, "Cannot resolve this agent")
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ code: "admission-failed" })
    const missing = await AppRuntime.runPromise(
      Session.Service.use((sessions) =>
        sessions
          .findMessage(tree.invalid.id, (message) => message.info.id === failedID)
          .pipe(Effect.map(Option.getOrUndefined)),
      ).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    expect(missing).toBeUndefined()

    for (const [parent, child] of [
      [tree.parent.id, tree.parent.id],
      [tree.wrong.id, tree.child.id],
      [tree.sibling.id, tree.child.id],
      [tree.parent.id, tree.nested.id],
    ] as const) {
      const response = await call(listener.url, parent, child, MessageID.ascending(), "Wrong route")
      expect(response.status).toBe(404)
    }
    const crossed = await call(listener.url, tree.parent.id, foreign.id, MessageID.ascending(), "Wrong directory")
    expect(crossed.status).toBe(404)

    await AppRuntime.runPromise(
      SessionRunState.Service.use((runs) => runs.cancel(tree.stale.id)).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    await staleRunning
    const stale = await call(listener.url, tree.parent.id, tree.stale.id, MessageID.ascending(), "Too late")
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: "inactive" })
  } finally {
    await AppRuntime.runPromise(
      SessionRunState.Service.use((runs) =>
        Effect.forEach([tree.child.id, tree.invalid.id, tree.stale.id], (id) => runs.cancel(id), { discard: true }),
      ).pipe(Effect.provideService(InstanceRef, ctx)),
    ).catch(() => undefined)
    await Promise.all([running, invalidRunning, staleRunning])
    await withTimeout(listener.stop(true), 10_000, "timed out stopping child steer listener")
  }
}, 30_000)
