import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import type { ConnectionState } from "../../src/services/cli-backend/connection-service"
import { PersonalTodoReminderCoordinator } from "../../src/services/personal-todo-reminders"

const reminder = {
  version: 1,
  state: "claimed",
  deliveryID: "delivery-1",
  claimID: "claim-1",
  todoID: "todo-1",
  todoRevision: 2,
  reminderRevision: 3,
  title: "Private test Todo",
  reminderAt: 1,
  claimedAt: 2,
  claimExpiresAt: 3,
}

async function until(done: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!done()) {
    if (Date.now() >= deadline) throw new Error("Todo coordinator did not settle")
    await Bun.sleep(1)
  }
}

// Real SDK requests cross held loopback responses. Only connection events and
// notification presentation are local adapters; no native notification is shown.
for (const mode of ["dispose", "replace", "same", "current", "show-dispose", "show-reconnect"] as const) {
  test(`Todo claim ownership: ${mode}`, async () => {
    const held = Promise.withResolvers<void>()
    const choice = Promise.withResolvers<string | undefined>()
    const requests: Array<{ path: string; body: unknown }> = []
    const shows: string[] = []
    const commands: string[] = []
    const listeners = new Set<(state: ConnectionState) => void>()
    const state: { value: ConnectionState; claims: number } = { value: "connected", claims: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Basic ${btoa("kilo:synthetic-only")}`)
        const path = new URL(request.url).pathname
        requests.push({ path, body: path.endsWith("/acknowledge") ? await request.json() : undefined })
        if (path === "/raya/personal-todos/reminders/acknowledge")
          return Response.json({ ...reminder, state: "acknowledged" })
        expect(path).toBe("/raya/personal-todos/reminders/claim")
        state.claims++
        if (state.claims !== 1) return Response.json([])
        await held.promise
        return Response.json([reminder])
      },
    })
    const client = () =>
      createKiloClient({
        baseUrl: server.url.toString(),
        headers: { Authorization: `Basic ${btoa("kilo:synthetic-only")}` },
      })
    const owner = { client: client() }
    const change = (next: ConnectionState) => {
      state.value = next
      for (const listener of listeners) listener(next)
    }
    let coordinator: PersonalTodoReminderCoordinator | undefined
    try {
      coordinator = new PersonalTodoReminderCoordinator(
        {
          getClient: () => owner.client,
          getConnectionState: () => state.value,
          onStateChange: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
        {
          show: (message) => {
            shows.push(message)
            if (mode === "show-dispose") coordinator?.dispose()
            if (mode === "show-reconnect") {
              change("disconnected")
              change("connected")
            }
            return choice.promise
          },
          execute: async (command) => {
            commands.push(command)
          },
          schedule: () => ({ dispose: () => undefined }),
        },
      )
      await until(() => state.claims === 1)
      if (mode === "dispose") coordinator.dispose()
      if (mode === "replace" || mode === "same") {
        change("disconnected")
        if (mode === "replace") owner.client = client()
        change("connected")
      }
      held.resolve()
      const current = coordinator
      await until(() => !current["active"])
      const acknowledgements = requests.filter((row) => row.path.endsWith("/acknowledge"))
      expect(shows).toEqual(mode === "current" || mode.startsWith("show-") ? ["Todo reminder: Private test Todo"] : [])
      expect(acknowledgements.map((row) => row.body)).toEqual(
        mode === "current" ? [{ deliveryID: "delivery-1", claimID: "claim-1" }] : [],
      )
      expect(state.claims).toBe(mode === "replace" || mode === "same" || mode === "show-reconnect" ? 2 : 1)
      // The pending choice did not prevent the current claim's acknowledgement.
      // A stale choice must not open Todo through the successor connection.
      choice.resolve("Open Todo")
      await choice.promise
      await Promise.resolve()
      expect(commands).toEqual(mode === "current" ? ["raya.todosButtonClicked"] : [])
    } finally {
      held.resolve()
      choice.resolve(undefined)
      coordinator?.dispose()
      const current = coordinator
      try {
        if (current) await until(() => !current["active"])
      } finally {
        await server.stop(true)
      }
    }
  })
}
