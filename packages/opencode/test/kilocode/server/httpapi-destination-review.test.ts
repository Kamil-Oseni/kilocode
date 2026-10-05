import { afterEach, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { RayaTask } from "@/kilocode/task"
import { Summary } from "@/kilocode/migration/destination-review"
import { Global } from "@opencode-ai/core/global"
import { Server } from "@/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("destination review binds exact evidence without enabling or replaying workers", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const route = "/kilocode/profile/restore-review"
  const post = (value: unknown) => app.request(route, { method: "POST", headers, body: JSON.stringify(value) })
  expect(await (await app.request(route, { headers })).json()).toMatchObject({ state: "absent" })
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Transferred worker",
      objective: "Keep paused",
      enabled: false,
      schedule: { kind: "manual" },
    }),
  })
  expect(created.status).toBe(200)
  const worker = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const root = Global.Path.data
  expect(path.resolve(root).startsWith(path.resolve(os.tmpdir(), `opencode-test-data-${process.pid}`) + path.sep)).toBe(
    true,
  )
  const marker = path.join(root, "storage", "raya", "restore-hold.json")
  const file = path.join(root, "restore-review.json")
  const roster = path.join(root, "storage", "raya", "agent.json")
  const before = await readFile(roster)
  const id = crypto.randomUUID()
  const held = JSON.stringify({ version: 1, id, state: "held", createdAt: Date.now() })
  const evidence = {
    format: "raya.restore-review",
    version: 1,
    bundle: crypto.randomUUID(),
    hold: id,
    workspaces: { "C:\\old\\workspace": directory.path },
    reconnectCredentials: true,
    uncertainWork: "held-no-replay",
  }
  await writeFile(marker, held, { flag: "wx" })
  await writeFile(file, JSON.stringify(evidence), { flag: "wx" })
  try {
    const loaded = await app.request(route, { headers })
    expect(loaded.status).toBe(200)
    const summary = Schema.decodeUnknownSync(Schema.toCodecJson(Summary))(await loaded.json())
    if (!summary.revision) throw new Error("Expected held revision")
    const approval = {
      id,
      revision: summary.revision,
      reviewed: true,
      workspacesAcknowledged: true,
      reconnectAcknowledged: true,
    }
    expect((await post({ ...approval, reconnectAcknowledged: false })).status).toBe(400)
    expect((await post({ ...approval, id: crypto.randomUUID() })).status).toBe(409)
    await writeFile(file, JSON.stringify({ ...evidence, workspaces: { "C:\\changed": directory.path } }))
    expect((await post(approval)).status).toBe(409)
    expect(await readFile(marker, "utf8")).toBe(held)
    await writeFile(file, "{broken")
    expect((await app.request(route, { headers })).status).toBe(503)
    expect((await post(approval)).status).toBe(503)
    await writeFile(file, JSON.stringify({ ...evidence, hold: crypto.randomUUID() }))
    expect((await app.request(route, { headers })).status).toBe(409)
    await writeFile(file, JSON.stringify(evidence))
    const accepted = await post(approval)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      state: "released",
      review: { by: "user", revision: summary.revision },
      workers: [{ id: worker.id, enabled: false }],
    })
    expect((await post(approval)).status).toBe(200)
    expect((await post({ ...approval, revision: "0".repeat(64) })).status).toBe(409)
    await disposeAllInstances()
    expect(await (await app.request(route, { headers })).json()).toMatchObject({
      state: "released",
      workers: [{ id: worker.id, enabled: false }],
    })
    expect(await readFile(roster)).toEqual(before)
    expect(await (await app.request(`/kilocode/agent/${worker.id}/runs`, { headers })).json()).toEqual([])
    await writeFile(marker, "{broken")
    expect((await app.request(route, { headers })).status).toBe(503)
  } finally {
    await rm(marker, { force: true })
    await rm(file, { force: true })
  }
}, 60_000)
