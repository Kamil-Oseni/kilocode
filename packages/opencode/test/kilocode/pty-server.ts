import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpServer } from "effect/unstable/http"
import * as Transport from "../../src/kilocode/pty/transport"

export const layer = Layer.unwrap(
  Effect.sync(() => {
    const server = createServer()
    return HttpServer.layerTestClient.pipe(
      Layer.provide(
        Layer.fresh(FetchHttpClient.layer).pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          NodeHttpServer.layer(() => server, { port: 0 }),
          Transport.layer(server),
        ),
      ),
    )
  }),
)
