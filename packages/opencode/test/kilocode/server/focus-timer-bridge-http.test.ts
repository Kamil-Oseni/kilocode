import { afterEach, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { handleFocusTimerMessage } from "../../../../kilo-vscode/src/kilo-provider/focus-timer"
import { Server } from "../../../src/server/server"
import { FocusTimerPaths } from "../../../src/kilocode/server/httpapi/groups/focus-timer"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })
const previous = { flag: Flag.KILO_SERVER_PASSWORD, env: process.env.KILO_SERVER_PASSWORD }

afterEach(async () => {
  Flag.KILO_SERVER_PASSWORD = previous.flag
  if (previous.env === undefined) delete process.env.KILO_SERVER_PASSWORD
  else process.env.KILO_SERVER_PASSWORD = previous.env
  await disposeAllInstances()
  await resetDatabase()
})

for (const mode of ["lost", "server", "replaced"] as const) {
  test(`focus bridge retains an actual committed pause with an unknown ${mode} response and never replays it`, async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    Flag.KILO_SERVER_PASSWORD = undefined
    delete process.env.KILO_SERVER_PASSWORD
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const owner = createKiloClient({ baseUrl: listener.url.toString(), directory: tmp.path })
      const idle = await owner.raya.focusTimer.get()
      if (!idle.data) throw new Error("Actual saved focus timer required")
      const baseline = idle.data.revision
      const started = await owner.raya.focusTimer.start({ revision: baseline, durationMs: 60_000 })
      expect(started.data).toMatchObject({ revision: baseline + 1, state: "running" })
      if (!started.data) throw new Error("Actual original start receipt required")
      const calls: Array<{ method: string; path: string }> = []
      const committed: unknown[] = []
      const scope = { current: true }
      // Forward the original request through the real listener. Only withhold its
      // successful response after consuming the actual persisted implementation's body.
      const transport = Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          const request = new Request(args[0], args[1])
          calls.push({ method: request.method, path: new URL(request.url).pathname })
          const response = await fetch(...args)
          if (request.method !== "POST" || new URL(request.url).pathname !== FocusTimerPaths.pause) return response
          expect(response.status).toBe(200)
          const body = await response.text()
          committed.push(JSON.parse(body))
          if (mode === "lost") throw new TypeError("Controlled response loss after original HTTP commit")
          if (mode === "replaced") {
            scope.current = false
            return new Response(body, { status: response.status, headers: response.headers })
          }
          return new Response(JSON.stringify({ message: "Controlled private diagnostic must not escape" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          })
        },
        { preconnect: fetch.preconnect },
      )
      const client = createKiloClient({ baseUrl: listener.url.toString(), directory: tmp.path, fetch: transport })
      const messages: unknown[] = []
      await handleFocusTimerMessage({
        client,
        directory: tmp.path,
        current: () => scope.current,
        message: { type: "focusTimerPause", requestID: `original-${mode}`, revision: started.data.revision },
        post: (message) => messages.push(message),
      })
      expect(committed).toHaveLength(1)
      expect(committed[0]).toMatchObject({ state: "paused", revision: baseline + 2 })
      const retained = await owner.raya.focusTimer.get()
      // Pause returns the just-cleared optional clock as null on this HTTP
      // encoding; the persisted JSON read omits it. Every other field is exact.
      expect(committed[0]).toHaveProperty("runStartedAt", null)
      expect(retained.data).not.toHaveProperty("runStartedAt")
      expect(committed[0]).toEqual({ ...retained.data, runStartedAt: null })
      expect(calls).toEqual([{ method: "POST", path: FocusTimerPaths.pause }])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: "focusTimerResult",
        requestID: `original-${mode}`,
        operation: "pause",
        error: { kind: "uncertain" },
      })
      expect(JSON.stringify(messages)).not.toContain("unchanged")
      expect(JSON.stringify(messages)).not.toContain("private diagnostic")
      expect(messages[0]).not.toHaveProperty("timer")
      expect((await owner.raya.focusTimer.get()).data).toEqual(retained.data)
    } finally {
      await listener.stop(true)
    }
  }, 30_000)
}
