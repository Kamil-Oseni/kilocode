import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { RoutineRefresh } from "../../src/kilo-provider/routine-refresh"

for (const marked of [true, false]) {
  test(`real SDK roster failure ${marked ? "presents known recovery guidance" : "retains the generic error boundary"}`, async () => {
    const messages: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("/agent"))
          return Response.json(
            {
              _tag: "InvalidRequestError",
              kind: "unavailable",
              field: marked ? "worker-roster" : "other",
              message: "Synthetic private backend diagnostic must not be displayed",
            },
            { status: 400 },
          )
        return Response.json([])
      },
    })
    const client = createKiloClient({ baseUrl: server.url.toString() })
    const refresh = new RoutineRefresh(
      () => ({ client, directory: "workspace", generation: 1 }),
      (message) => messages.push(message),
    )
    try {
      await refresh.request("recovery", "recovery")
      expect(messages.at(-1)).toMatchObject({ type: "routineState", refresh: "error", requestID: "recovery" })
      expect(messages.at(-1)?.error).toBe(
        marked
          ? "Your saved worker list is missing from an initialized profile. Restore the worker list from a backup before creating or running workers. Previously loaded information is retained."
          : "Routines could not be refreshed. Previously loaded information is retained. Retry when connected.",
      )
      expect(JSON.stringify(messages)).not.toContain("Synthetic private backend diagnostic")
      expect(messages.some((message) => "agents" in message)).toBe(false)
    } finally {
      refresh.dispose()
      await server.stop(true)
    }
  })
}
