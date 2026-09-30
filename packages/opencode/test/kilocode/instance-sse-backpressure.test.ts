import { afterEach, describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { GlobalBus } from "@/bus/global"
import { EventPaths } from "@/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

const it = testEffect(httpApiLayer)
const frame = (data: string) => JSON.parse(data) as { type: string; properties: Record<string, unknown> }

const read = (directory: string, publish: () => void) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    expect(response.status).toBe(200)
    // No reader is attached during publication: the server must bound this backlog itself.
    publish()
    const result = yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.map((item) => frame(item.data)),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    )
    return Array.from(result)
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("instance SSE backpressure", () => {
  it.instance(
    "signals count overflow and closes a stalled stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const before = GlobalBus.listenerCount("event")
        const frames = yield* read(directory, () => {
          for (let index = 0; index < 257; index++)
            GlobalBus.emit("event", {
              directory,
              payload: { type: "test.count", properties: { index } },
            })
        })
        expect(frames.map((item) => item.type)).toEqual(["server.connected", "server.resync_required"])
        expect(frames[1]?.properties).toEqual({ reason: "overflow" })
        expect(GlobalBus.listenerCount("event")).toBe(before)
        const response = yield* requestInDirectory(EventPaths.event, directory)
        expect(response.status).toBe(200)
        GlobalBus.emit("event", {
          directory,
          payload: { type: "test.after-reconnect", properties: { cursor: 258 } },
        })
        const resumed = yield* response.stream.pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.map((item) => frame(item.data)),
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
        )
        expect(Array.from(resumed).map((item) => item.type)).toEqual(["server.connected", "test.after-reconnect"])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "signals serialized-byte overflow before the count limit",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const frames = yield* read(directory, () => {
          for (let index = 0; index < 14; index++)
            GlobalBus.emit("event", {
              directory,
              payload: { type: "test.bytes", properties: { index, body: "x".repeat(40_000) } },
            })
        })
        expect(frames.map((item) => item.type)).toEqual(["server.connected", "server.resync_required"])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "prioritizes instance disposal over queued ordinary events",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const frames = yield* read(directory, () => {
          for (let index = 0; index < 257; index++)
            GlobalBus.emit("event", {
              directory,
              payload: { type: "test.count", properties: { index } },
            })
          GlobalBus.emit("event", {
            directory,
            payload: { type: "server.instance.disposed", properties: { directory } },
          })
        })
        expect(frames.map((item) => item.type)).toEqual(["server.connected", "server.instance.disposed"])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )
})
