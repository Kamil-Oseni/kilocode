import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { make } from "@opencode-ai/core/background-job"
import { cancel } from "@/kilocode/server/httpapi/background-cancel"
import { BackgroundJobCancelEndpoint } from "@/kilocode/server/httpapi/groups/kilocode"

test("the production cancellation endpoint schema and handler select only the displayed execution revision", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* make
        const endpoint = BackgroundJobCancelEndpoint
        const api = HttpApi.make("exact-cancel-test").add(HttpApiGroup.make("exact").add(endpoint))
        const spec = OpenApi.fromApi(api)
        expect(spec.paths["/kilocode/background-jobs/{jobID}/cancel"]?.post?.requestBody?.required).toBe(true)
        const handlers = HttpApiBuilder.group(api, "exact", (group) =>
          group.handle("backgroundJobCancel", cancel(jobs)),
        )
        const router = HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(handlers),
            Layer.provide(HttpServer.layerServices),
            Layer.provide(NodeServices.layer),
          ),
          { disableLogger: true },
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => router.dispose()))
        const request = (id: string, body?: unknown) =>
          Effect.promise(() =>
            router.handler(
              new Request(`http://localhost/kilocode/background-jobs/${id}/cancel`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
              Context.empty(),
            ),
          )
        const old = yield* jobs.start({ id: "reused-http", type: "task", run: Effect.succeed("completed") })
        yield* jobs.wait({ id: old.id })
        const ready = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const next = yield* jobs.start({
          id: old.id,
          type: "task",
          run: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        })
        yield* Deferred.await(ready)
        expect((yield* request(next.id, { revision: old.revision })).status).toBe(409)
        expect((yield* jobs.get(next.id))?.status).toBe("running")
        expect((yield* request(next.id)).status).toBe(400)
        expect((yield* request(next.id, { revision: "" })).status).toBe(400)
        expect((yield* request(next.id, {})).status).toBe(400)
        expect((yield* request("missing", { revision: "unknown" })).status).toBe(404)
        const response = yield* request(next.id, { revision: next.revision })
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toBe(true)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* jobs.get(next.id))?.status).toBe("cancelled")
        const terminal = yield* request(next.id, { revision: next.revision })
        expect(yield* Effect.promise(() => terminal.json())).toBe(false)
      }),
    ),
  )
})
