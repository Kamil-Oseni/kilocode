import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../../src/auth"
import { GlobalBus } from "../../../src/bus/global"
import { Config } from "../../../src/config/config"
import { Installation } from "../../../src/installation"
import { ServerAuth } from "../../../src/server/auth"
import { RootHttpApi } from "../../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../../src/server/routes/instance/httpapi/middleware/schema-error"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { pollWithTimeout, testEffect } from "../../lib/effect"

const layer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
  // Raw HttpApi routes expose an opaque handler context at the web boundary.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Layer.provide(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
)
const it = testEffect(layer)
const frame = Schema.decodeUnknownSync(
  Schema.Struct({ payload: Schema.Struct({ type: Schema.String, properties: Schema.Unknown }) }),
)

describe("global SSE overflow", () => {
  it.live(
    "delivers a resync receipt then closes after a synchronous event burst exceeds its queue",
    () =>
      Effect.gen(function* () {
        const listeners = GlobalBus.listenerCount("event")
        const response = yield* HttpClient.get(GlobalPaths.event)
        expect(response.status).toBe(200)
        const stream = response.stream.pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.map((event) => frame(JSON.parse(event.data))),
          Stream.runCollect,
        )
        const fiber = yield* stream.pipe(Effect.forkChild({ startImmediately: true }))
        yield* pollWithTimeout(
          Effect.sync(() => (GlobalBus.listenerCount("event") === listeners + 1 ? true : undefined)),
          "global overflow stream did not subscribe",
        )
        yield* Effect.sync(() => {
          for (let index = 0; index < 300; index++)
            GlobalBus.emit("event", { payload: { type: "test.event", properties: { index } } })
        })
        const frames = yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
        expect(frames[0]?.payload.type).toBe("server.connected")
        expect(frames.filter((frame) => frame.payload.type === "test.event")).toHaveLength(256)
        expect(frames.at(-1)?.payload).toMatchObject({
          type: "server.resync_required",
          properties: { reason: "overflow" },
        })
        yield* pollWithTimeout(
          Effect.sync(() => (GlobalBus.listenerCount("event") === listeners ? true : undefined)),
          "global overflow stream did not release its listener",
        )
      }),
    20_000,
  )
})
