import assert from "node:assert/strict"
import path from "node:path"
import { open } from "node:fs/promises"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { waitForServe } from "../../../src/kilocode/cli/serve-shutdown"
import { admission } from "../../../src/kilocode/server/listener"
import { failure } from "../../../src/kilocode/migration/source-failure"
import { finish } from "../../../src/kilocode/cli/finish"

const root = process.argv[2]
const secret = "PRIVATE_CLEANUP_PASSWORD_AND_PATH"
const file = await open(path.join(root, secret), "w")
const scope = Scope.makeUnsafe()
const gate = admission()
const layer = HttpRouter.serve(HttpRouter.add("GET", "/", Effect.succeed(HttpServerResponse.text("actual"))), {
  middleware: gate.middleware,
}).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })))
const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))
const server = Context.get(ctx, HttpServer.HttpServer)
assert.equal(server.address._tag, "TcpAddress")
if (server.address._tag !== "TcpAddress") throw new Error("Actual TCP address absent")
const url = `http://127.0.0.1:${server.address.port}`
assert.equal(await (await fetch(url)).text(), "actual")
const timer = setTimeout(() => process.emit("SIGTERM"), 100)
const result = await Promise.allSettled([
  waitForServe({
    async quiesce() {
      await gate.quiesce()
      await file.close()
      await file.write("late").catch((err: unknown) => {
        if (err instanceof Error) err.message = secret
        throw err
      })
    },
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }),
])
clearTimeout(timer)
assert.equal(result[0].status, "rejected")
if (result[0].status !== "rejected") throw new Error("Expected actual closed native handle failure")
const value = failure(result[0].reason)
assert.ok(value.errors.some((item) => item.code === "RAYA_SERVE_HTTP_DRAIN_FAILED"))
assert.ok(value.errors.some((item) => item.code === "EBADF"))
assert.equal(JSON.stringify(value).includes(secret), false)
await assert.rejects(fetch(url))
console.log("SERVE_DIAGNOSTIC_NATIVE_PASS")
// The native finalizer fault remains a refusal; the child never reports a clean exit.
process.exitCode = 1
await finish([])
