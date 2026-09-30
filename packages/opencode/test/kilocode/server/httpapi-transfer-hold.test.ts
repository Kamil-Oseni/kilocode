import { afterEach, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Server } from "@/server/server"
import { RayaTask } from "@/kilocode/task"
import { Page } from "@/kilocode/task/inbox"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("a held HTTP follow-up refuses before persisting an inbox message or run", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Retained worker",
      objective: "Keep my work",
      enabled: false,
      schedule: { kind: "manual" },
    }),
  })
  expect(created.status).toBe(200)
  const worker = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const route = `/kilocode/agent/${worker.id}/inbox`
  const page = Schema.decodeUnknownSync(Schema.toCodecJson(Page))
  const before = page(await (await app.request(route, { headers })).json())
  const root = path.join(Global.Path.data, "storage", "raya")
  expect(path.resolve(root).startsWith(path.resolve(os.tmpdir(), `opencode-test-data-${process.pid}`) + path.sep)).toBe(
    true,
  )
  const marker = path.join(root, "restore-hold.json")
  expect(await Bun.file(marker).exists()).toBe(false)
  const roster = await readFile(path.join(root, "agent.json"))
  const held = JSON.stringify({ version: 1, id: crypto.randomUUID(), state: "held", createdAt: Date.now() })
  await writeFile(marker, held, { flag: "wx" })
  try {
    for (const restart of [false, true]) {
      if (restart) await disposeAllInstances()
      const refused = await app.request(route, {
        method: "POST",
        headers,
        body: JSON.stringify({ source: `held-follow-up-${restart}`, body: "This must not enter the inbox" }),
      })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({
        _tag: "InvalidRequestError",
        kind: "paused",
        field: "restore-hold",
        message: "This transferred profile is paused. Review it on this computer before starting workers.",
      })
      expect(page(await (await app.request(route, { headers })).json()).messages).toEqual(before.messages)
      expect(await (await app.request(`/kilocode/agent/${worker.id}/runs`, { headers })).json()).toEqual([])
      expect((await app.request("/kilocode/agent", { headers })).status).toBe(200)
      expect(await readFile(path.join(root, "agent.json"))).toEqual(roster)
      expect(await readFile(marker, "utf8")).toBe(held)
    }
  } finally {
    await rm(marker)
  }
}, 60_000)
