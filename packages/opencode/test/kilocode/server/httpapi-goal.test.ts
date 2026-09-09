// raya_change - Milestone A goal HTTP persistence contract
import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import path from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID, MessageID } from "@/session/schema"
import { receipts } from "@/kilocode/goal/stop-receipt"

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
  test("stop history preserves requested and observed delegated attempts through the HTTP schema", async () => {
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
    const created = await request("POST", "/session", {})
    const session = (await created.json()) as { id: string }
    const receipt = {
      sessionID: SessionID.make(session.id),
      intent: "saved-attempts",
      phase: "cleared" as const,
      at: 1,
      operations: [
        { id: "pending", jobID: "child", revision: "r1", at: 1, phase: "requested" as const },
        {
          id: "observed",
          jobID: "shared",
          revision: "r2",
          messageID: MessageID.ascending(),
          at: 1,
          phase: "observed" as const,
          observedAt: 2,
          result: "accepted" as const,
        },
      ],
    }
    await Effect.runPromise(
      Storage.Service.use((storage) => receipts(storage).save(receipt)).pipe(
        Effect.provide(
          LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, Git.node, CrossSpawnSpawner.node])),
        ),
      ),
    )
    const route = `/session/${session.id}/goal/stop`
    const loaded = await request("GET", route)
    expect(loaded.status).toBe(200)
    expect(await loaded.json()).toEqual(receipt)
    const replay = await request("POST", route, { expectedIntent: receipt.intent })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(receipt)
  }, 30_000)

  test("conditionally saves a combined goal edit and rejects stale or invalid requests", async () => {
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
    const session = await request("POST", "/session", {})
    expect(session.status).toBe(200)
    const data = (await session.json()) as { id: string }
    const route = `/session/${data.id}/goal`
    const created = await request("POST", route, { objective: "Original direction" })
    expect(created.status).toBe(200)
    const original = (await created.json()) as { intent: string }
    const response = await request("PATCH", route, {
      objective: "Reviewed direction",
      status: "paused",
      expectedIntent: original.intent,
    })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as { intent: string; objective: string; status: string }
    expect(saved.objective).toBe("Reviewed direction")
    expect(saved.status).toBe("paused")
    expect(saved.intent).not.toBe(original.intent)
    const persisted = await (await request("GET", route)).json()
    expect(persisted).toMatchObject({ objective: saved.objective, status: saved.status, intent: saved.intent })
    for (const patch of [
      { objective: "Stale edit", status: "active", expectedIntent: original.intent },
      { objective: "Stale no-version edit", expectedIntent: "unset" },
    ]) {
      expect((await request("PATCH", route, patch)).status).toBe(409)
      expect(await (await request("GET", route)).json()).toEqual(persisted)
    }
    expect(
      (await request("PATCH", route, { objective: "  ", status: "active", expectedIntent: saved.intent })).status,
    ).toBe(400)
    expect(await (await request("GET", route)).json()).toEqual(persisted)
    const updated = await request("PATCH", route, { objective: "New paused direction", expectedIntent: saved.intent })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ objective: "New paused direction", status: "paused" })
    const criteria = [{ id: "result", description: "Working result", verification: "Run checks", required: false }]
    const basis = (await (await request("GET", route)).json()) as { intent: string }
    expect((await request("PATCH", route, { criteria })).status).toBe(400)
    expect((await request("PATCH", route, { criteria: [], expectedIntent: basis.intent })).status).toBe(400)
    expect(
      (
        await request("PATCH", route, {
          criteria: [{ ...criteria[0], required: "false" }],
          expectedIntent: basis.intent,
        })
      ).status,
    ).toBe(400)
    const criteriaResponse = await request("PATCH", route, { criteria, expectedIntent: basis.intent })
    expect(criteriaResponse.status).toBe(200)
    expect(await criteriaResponse.json()).toMatchObject({
      criteria,
      objective: "New paused direction",
      status: "paused",
    })
    expect(await (await request("GET", route)).json()).toMatchObject({
      criteria,
      revisions: [
        { objective: "Original direction", source: "control" },
        { objective: "Reviewed direction", source: "control" },
        { objective: "New paused direction", source: "control" },
      ],
    })
    expect((await request("PATCH", route, { criteria, expectedIntent: basis.intent })).status).toBe(409)
    const latest = (await (await request("GET", route)).json()) as { intent: string }
    for (const intent of [original.intent, saved.intent, "unset"]) {
      expect((await request("DELETE", `${route}?expectedIntent=${encodeURIComponent(intent)}`)).status).toBe(409)
      expect(await (await request("GET", route)).json()).toEqual(latest)
    }
    expect((await request("DELETE", `${route}?expectedIntent=`)).status).toBe(400)
    expect(await (await request("GET", route)).json()).toEqual(latest)
    expect((await request("POST", `${route}/stop`, { expectedIntent: "" })).status).toBe(400)
    expect((await request("POST", `${route}/stop`, { expectedIntent: "stale" })).status).toBe(409)
    expect((await request("GET", `${route}/stop`)).status).toBe(404)
    const cleared = await request("POST", `${route}/stop`, { expectedIntent: latest.intent })
    expect(cleared.status).toBe(200)
    const receipt = await cleared.json()
    expect(receipt).toMatchObject({ intent: latest.intent, phase: "finished", interrupted: false })
    expect(receipt).toMatchObject({ background: { status: "checked", at: expect.any(Number), jobs: [] } })
    expect(await (await request("GET", `${route}/stop`)).json()).toEqual(receipt)
    expect(await (await request("POST", `${route}/stop`, { expectedIntent: latest.intent })).json()).toEqual(receipt)
    expect((await request("GET", route)).status).toBe(404)
    expect((await request("DELETE", `${route}?expectedIntent=${encodeURIComponent(latest.intent)}`)).status).toBe(200)
  }, 30_000)

  test("creates, reloads, updates, and clears session goal state", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
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

  test("steers an active goal instead of 400ing a second /goal", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const request = (handler: ReturnType<typeof app>, method: string, route: string, body?: unknown) =>
      handler(
        new Request(new URL(route, "http://localhost"), {
          method,
          headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        HttpApiServer.context,
      )
    const handler = app()
    const createdSession = await request(handler, "POST", "/session", {})
    const session = (await createdSession.json()) as { id: string }
    const first = await request(handler, "POST", `/session/${session.id}/goal`, {
      objective: "Add the date comment",
      messageID: "msg_goal_first",
    })
    expect(first.status).toBe(200)
    const steered = await request(handler, "POST", `/session/${session.id}/goal`, {
      objective: "Add it again and say Jesus Rocks",
      messageID: "msg_goal_steer",
    })
    expect(steered.status).toBe(200)
    expect((await steered.json()) as { objective: string; status: string }).toMatchObject({
      objective: "Add it again and say Jesus Rocks",
      status: "active",
    })
  }, 30_000)

  // raya_change - goal rollback uses its own workspace checkpoint, including child-created files
  test("discard removes files created after the goal checkpoint", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const request = (handler: ReturnType<typeof app>, method: string, route: string, body?: unknown) =>
      handler(
        new Request(new URL(route, "http://localhost"), {
          method,
          headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        HttpApiServer.context,
      )
    const handler = app()
    const created = await request(handler, "POST", "/session", {})
    const session = (await created.json()) as { id: string }
    const goal = await request(handler, "POST", `/session/${session.id}/goal`, {
      objective: "Create one temporary file",
      messageID: "msg_goal_discard",
    })
    expect(goal.status).toBe(200)
    expect((await goal.json()) as { startSnapshot?: string }).toMatchObject({
      startSnapshot: expect.any(String),
    })

    const file = path.join(tmp.path, "created-by-child.txt")
    await Bun.write(file, "temporary\n")
    expect(await Bun.file(file).exists()).toBe(true)

    const discarded = await request(handler, "POST", `/session/${session.id}/goal/discard`)
    expect(discarded.status).toBe(200)
    expect(await Bun.file(file).exists()).toBe(false)
    expect((await request(handler, "GET", `/session/${session.id}/goal`)).status).toBe(404)
  }, 30_000)
})
