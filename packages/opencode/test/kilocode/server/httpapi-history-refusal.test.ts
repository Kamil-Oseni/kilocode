import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Server } from "@/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("actual HTTP history consumers report retained history refusal while healthy routine preview remains available", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const ids: string[] = []
  for (const name of ["Affected history", "Healthy history"]) {
    const response = await app.request("/kilocode/agent", {
      method: "POST",
      headers,
      body: JSON.stringify({ name, objective: "Work", access: "brief", schedule: { kind: "manual" } }),
    })
    expect(response.status).toBe(200)
    ids.push(Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await response.json()).id)
  }
  const file = path.join(Global.Path.data, "storage", "raya", "agent-runs", `${ids[0]}.json`)
  expect(path.resolve(file).startsWith(path.resolve(os.tmpdir(), `opencode-test-data-${process.pid}`) + path.sep)).toBe(
    true,
  )
  expect(await Bun.file(file).exists()).toBe(false)
  await mkdir(path.dirname(file), { recursive: true })
  const bytes = Buffer.from('{"version":1,"private":"SYNTHETIC_PRIVATE_HISTORY"}')
  await writeFile(file, bytes)
  try {
    const list = await app.request("/kilocode/agent", { headers })
    expect(list.status).toBe(200)
    const items = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.NullOr(Schema.String)) })),
    )(await list.json())
    expect(items.find((item) => item.id === ids[0])?.note).toContain("history needs attention")
    expect(items.some((item) => item.id === ids[1])).toBe(true)
    for (const route of [`/kilocode/agent/${ids[0]}/runs`, "/kilocode/agent-inbox"]) {
      const response = await app.request(route, { headers })
      expect(response.status).toBe(400)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual({
        _tag: "InvalidRequestError",
        kind: "unavailable",
        field: "history",
        message: "Routine history needs attention. Its retained data has not been changed.",
      })
      expect(text).not.toContain("SYNTHETIC_PRIVATE_HISTORY")
      expect(await readFile(file)).toEqual(bytes)
    }
    const healthy = await app.request(`/kilocode/agent/${ids[1]}/runs`, { headers })
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toEqual([])
  } finally {
    await rm(file)
  }
  const restored = await app.request(`/kilocode/agent/${ids[0]}/runs`, { headers })
  expect(restored.status).toBe(200)
  expect(await restored.json()).toEqual([])
}, 60_000)
