import { afterEach, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
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

test("HTTP updates cannot assert tested or installed completion or reassign repair ownership", async () => {
  await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  const handler = app()
  const request = (method: string, route: string, body?: unknown) =>
    handler(
      new Request(new URL(route, "http://localhost"), {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      HttpApiServer.context,
    )
  const response = await request("POST", "/kilocode/self-heal", {
    description: `Reject forged completion ${crypto.randomUUID()}`,
  })
  expect(response.status).toBe(200)
  const item = (await response.json()) as { id: string }
  for (const body of [
    { status: "verified", evidence: [{ summary: "invented", at: 1 }] },
    { reloadRequired: true },
    { workSessionID: "ses_unowned" },
  ]) {
    const blocked = await request("PATCH", `/kilocode/self-heal/${item.id}`, body)
    expect(blocked.status).toBe(409)
  }
  const observed = await request("GET", `/kilocode/self-heal/${item.id}`)
  expect(await observed.json()).toMatchObject({ status: "triaged", reloadRequired: false })
  const review = {
    artifactID: crypto.randomUUID(),
    digest: "0".repeat(64),
    extension: "7.4.23-repair+deadbeef",
  }
  expect((await request("POST", `/kilocode/self-heal/${item.id}/artifact/review`, review)).status).toBe(409)
  expect((await request("POST", "/kilocode/self-heal/heal_missing/artifact/review", review)).status).toBe(404)
  const session = (await (await request("POST", "/session", {})).json()) as { id: string }
  const forged = await request("POST", `/session/${session.id}/goal`, {
    objective: "Unrelated success",
    selfHealID: item.id,
  })
  expect(forged.status).toBe(400)
}, 60_000)
