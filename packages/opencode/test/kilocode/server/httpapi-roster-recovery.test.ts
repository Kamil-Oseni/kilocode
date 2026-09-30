import { afterEach, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Global } from "@opencode-ai/core/global"
import { Server } from "@/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("HTTP worker list and creation explain missing saved workers without replacing the roster", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const input = { name: "Retained worker", objective: "Keep my work", schedule: { kind: "manual" } }
  const response = await app.request("/kilocode/agent", { method: "POST", headers, body: JSON.stringify(input) })
  expect(response.status).toBe(200)
  const worker = (await response.json()) as { id: string }
  const roster = path.join(Global.Path.data, "storage", "raya", "agent.json")
  // Test preload creates this private profile. Never remove a real profile file.
  expect(
    path.resolve(roster).startsWith(path.resolve(os.tmpdir(), `opencode-test-data-${process.pid}`) + path.sep),
  ).toBe(true)
  const bytes = await readFile(roster)
  await rm(roster)
  try {
    await disposeAllInstances()
    for (const method of ["GET", "POST"]) {
      const result = await app.request("/kilocode/agent", {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify({ ...input, name: "Must refuse replacement" }) } : {}),
      })
      expect(result.status).toBe(400)
      expect(await result.json()).toEqual({
        _tag: "InvalidRequestError",
        kind: "unavailable",
        field: "worker-roster",
        message:
          "Your saved worker list is missing from an initialized profile. Restore the worker list from a backup before creating or running workers.",
      })
      expect(await Bun.file(roster).exists()).toBe(false)
    }
  } finally {
    await writeFile(roster, bytes)
  }
  await disposeAllInstances()
  const restored = await app.request("/kilocode/agent", { headers })
  expect(restored.status).toBe(200)
  expect(((await restored.json()) as { id: string }[]).some((item) => item.id === worker.id)).toBe(true)
  expect(await readFile(roster)).toEqual(bytes)
}, 60_000)
