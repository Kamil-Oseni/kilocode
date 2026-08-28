// raya_change - Milestone A goal HTTP persistence contract
import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

void Log.init({ print: false })

function app() {
  return HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("goal HTTP API", () => {
  test("creates, reloads, updates, and clears session goal state", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const request = (handler: ReturnType<typeof app>, method: string, route: string, body?: unknown) =>
      handler(
        new Request(new URL(route, "http://localhost"), {
          method,
          headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        HttpApiServer.context,
      )

    const first = app()
    const createdSession = await request(first, "POST", "/session", {})
    expect(createdSession.status).toBe(200)
    const session = (await createdSession.json()) as { id: string }

    const created = await request(first, "POST", `/session/${session.id}/goal`, {
      objective: "Persist through a client reload",
      messageID: "msg_goal_start",
    })
    expect(created.status).toBe(200)
    expect((await created.json()) as { status: string }).toMatchObject({
      status: "active",
      startMessageID: "msg_goal_start",
    })

    const reloaded = app()
    const restored = await request(reloaded, "GET", `/session/${session.id}/goal`)
    expect(restored.status).toBe(200)
    expect((await restored.json()) as { objective: string }).toMatchObject({
      objective: "Persist through a client reload",
    })

    const revised = await request(reloaded, "PATCH", `/session/${session.id}/goal`, {
      objective: "Apply steering on the next turn",
    })
    expect(revised.status).toBe(200)
    expect((await revised.json()) as { objective: string }).toMatchObject({
      objective: "Apply steering on the next turn",
    })

    const paused = await request(reloaded, "PATCH", `/session/${session.id}/goal`, { status: "paused" })
    expect(paused.status).toBe(200)
    expect((await paused.json()) as { status: string }).toMatchObject({ status: "paused" })

    const cleared = await request(reloaded, "DELETE", `/session/${session.id}/goal`)
    expect(cleared.status).toBe(200)
    const missing = await request(reloaded, "GET", `/session/${session.id}/goal`)
    expect(missing.status).toBe(404)
  }, 30_000)
})
