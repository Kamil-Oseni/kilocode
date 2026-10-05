import { afterEach, expect, spyOn, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { RayaGoal } from "@/kilocode/goal"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { AppRuntime } from "@/effect/app-runtime"
import { Storage } from "@/storage/storage"
function app() {
  return HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" })),
      ),
    ),
    { disableLogger: true },
  ).handler
}
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})
for (const mode of ["fresh", "user", "paused", "blocked"] as const) {
  test(`actual HTTP goal configuration and continuation: ${mode}`, async () => {
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
    const session = (await (await request("POST", "/session", {})).json()) as { id: string }
    const route = `/session/${session.id}/goal`

    const sid = SessionID.make(session.id)
    const ctx = await AppRuntime.runPromise(
      InstanceStore.Service.use((instances) => instances.load({ directory: tmp.path })),
    )
    const local = <A, E>(body: Effect.Effect<A, E, Session.Service | Storage.Service>) =>
      AppRuntime.runPromise(body.pipe(Effect.provideService(InstanceRef, ctx)))
    if (mode === "user") {
      const response = await request("POST", `/session/${session.id}/message`, {
        agent: "auto",
        noReply: true,
        parts: [{ type: "text", text: "Controlled original user work" }],
      })
      expect(response.status).toBe(200)
      expect(
        (await (await request("GET", `/session/${session.id}/message`)).json()).map(
          (row: { info: { role: string } }) => row.info.role,
        ),
      ).toEqual(["user"])
    }
    const goal = (await (await request("POST", route, { objective: "Original requested work" })).json()) as {
      intent: string
    }
    if (mode === "paused")
      expect((await request("PATCH", route, { status: "paused", expectedIntent: goal.intent })).status).toBe(200)
    if (mode === "blocked")
      await local(
        Storage.Service.use((storage) =>
          Session.Service.use((sessions) =>
            RayaGoal.make({ storage, sessions }).update(sid, { status: "blocked", reason: "Controlled pending work" }),
          ),
        ),
      )
    const current = (await (await request("GET", route)).json()) as { intent: string }
    const resumed = RayaGoalContinuation.resume
    const calls: string[] = []
    // Only model transport is scripted; actual HTTP/Goal/continuation/dispatch remain.
    const transport = spyOn(RayaGoalContinuation, "resume").mockImplementation((input) =>
      resumed({
        ...input,
        run: async (id) => {
          calls.push(id)
        },
      }),
    )
    try {
      const body =
        mode === "paused" || mode === "blocked"
          ? { status: "active", expectedIntent: current.intent }
          : {
              criteria: [
                { id: "work", description: "Original whole requested work", verification: "Verify actual work" },
              ],
              expectedIntent: current.intent,
            }
      const changed = await request("PATCH", route, body)
      expect(changed.status).toBe(200)
      const value = (await changed.json()) as RayaGoal.State
      expect(value.status).toBe("active")
      for (let count = 0; count < 100 && mode !== "fresh" && !calls.length; count++) await Bun.sleep(10)
      if (mode === "fresh") {
        await Bun.sleep(30)
        expect(calls).toEqual([])
        expect(transport).not.toHaveBeenCalled()
        expect(await (await request("GET", `/session/${session.id}/message`)).json()).toEqual([])
        const saved = await local(
          Storage.Service.use((storage) => storage.read<RayaGoal.State>(["raya", "goal", session.id])),
        )
        expect(saved.dispatch).toBeUndefined()
        expect(saved.criteria).toEqual(value.criteria)
        expect(
          (
            await request("PATCH", route, {
              criteria: [{ id: "stale", description: "Stale work", verification: "Verify" }],
              expectedIntent: current.intent,
            })
          ).status,
        ).toBe(409)
      } else {
        expect(transport).toHaveBeenCalledTimes(1)
        expect(calls).toEqual([session.id])
        const saved = await local(
          Storage.Service.use((storage) => storage.read<RayaGoal.State>(["raya", "goal", session.id])),
        )
        expect(saved.dispatch?.phase).toBe("started")
      }
    } finally {
      transport.mockRestore()
    }
  }, 30000)
}
