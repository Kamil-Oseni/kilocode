import { expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"

function server(password?: string) {
  return HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KILO_SERVER_PASSWORD: password,
            KILO_SERVER_USERNAME: "capability-reader",
            KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  )
}

test("the shipped HTTP server advertises exact-command validation without a workspace or mutation", async () => {
  const app = server()
  try {
    const response = await app.handler(new Request("http://localhost/kilocode/capabilities"), HttpApiServer.context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 1, features: { "goal.commandCheck": 1 } })
  } finally {
    await app.dispose()
  }
}, 30_000)

test("capability discovery follows configured server authentication", async () => {
  const app = server("capability-secret")
  try {
    for (const credentials of [undefined, "capability-reader:wrong", "wrong:capability-secret"]) {
      const response = await app.handler(
        new Request("http://localhost/kilocode/capabilities", {
          headers: credentials ? { authorization: `Basic ${Buffer.from(credentials).toString("base64")}` } : {},
        }),
        HttpApiServer.context,
      )
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toContain("Basic")
    }
    const response = await app.handler(
      new Request("http://localhost/kilocode/capabilities", {
        headers: { authorization: `Basic ${Buffer.from("capability-reader:capability-secret").toString("base64")}` },
      }),
      HttpApiServer.context,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 1, features: { "goal.commandCheck": 1 } })
  } finally {
    await app.dispose()
  }
}, 30_000)
