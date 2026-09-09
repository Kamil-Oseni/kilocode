import { expect } from "bun:test"
import { Effect } from "effect"
import { createKiloClient } from "@kilocode/sdk/v2"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "real CLI server provides goal worker services for create, read and stop",
  ({ opencode }) =>
    Effect.gen(function* () {
      const server = yield* opencode.serve({ readyTimeoutMs: 30_000 })
      const client = createKiloClient({ baseUrl: server.url })
      const session = yield* Effect.promise(() => client.session.create({}, { throwOnError: true }))
      if (!session.data) throw new Error("Missing created session")
      const sessionID = session.data.id
      const created = yield* Effect.promise(() =>
        client.kilocode.goal.create({ sessionID, objective: "Verify server goal lifecycle" }, { throwOnError: true }),
      )
      expect(created.data?.status).toBe("active")
      const saved = yield* Effect.promise(() => client.kilocode.goal.get({ sessionID }, { throwOnError: true }))
      expect(saved.data?.intent).toBe(created.data?.intent)
      if (!saved.data?.intent) throw new Error("Missing goal intent")
      const expectedIntent = saved.data.intent
      const stopped = yield* Effect.promise(() =>
        client.kilocode.goal.stop({ sessionID, expectedIntent }, { throwOnError: true }),
      )
      expect(stopped.data).toMatchObject({ sessionID, intent: expectedIntent, phase: "finished", interrupted: false })
      const remaining = yield* Effect.promise(() => client.kilocode.goal.get({ sessionID }))
      expect(remaining.response.status).toBe(404)
      const error: unknown = remaining.error
      expect(error).toEqual({ _tag: "NotFound" })
    }),
  60_000,
)
