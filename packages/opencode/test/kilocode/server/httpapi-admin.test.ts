import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Schema } from "effect"
import { RayaAdminLog } from "@/kilocode/admin/log"
import { RayaAdmin } from "@/kilocode/admin/registry"
import { Server } from "@/server/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

test("the Admin API returns isolated redacted health and bounded workspace logs", async () => {
  await using root = await tmpdir()
  await using first = await tmpdir({ config: { formatter: false, lsp: false } })
  await using second = await tmpdir({ config: { formatter: false, lsp: false } })
  const data = Global.Path.data
  ;(Global.Path as { data: string }).data = root.path
  await disposeAllInstances()
  const app = Server.Default().app
  const request = (route: string, directory = first.path) =>
    app.request(route, { headers: { "x-kilo-directory": directory } })

  try {
    const healthy = await request("/raya/admin/health")
    expect(healthy.status).toBe(200)
    const snapshot = Schema.decodeUnknownSync(RayaAdmin.Snapshot)(await healthy.json())
    expect(snapshot.items.map((row) => [row.id, row.status, row.reason])).toEqual([
      ["runtime", "healthy", "ready"],
      ["sessions", "healthy", "ready"],
      ["routines", "healthy", "ready"],
      ["agents", "healthy", "ready"],
      ["browser", "unknown", "not-checked"],
      ["voice", "unknown", "not-checked"],
    ])
    expect(JSON.stringify(snapshot)).not.toContain(first.path)

    const recent = await request("/raya/admin/logs?limit=2")
    expect(recent.status).toBe(200)
    const latest = Schema.decodeUnknownSync(Schema.Array(RayaAdminLog.Entry))(await recent.json())
    expect(latest.map((entry) => entry.seq)).toEqual([5, 6])

    const page = await request("/raya/admin/logs?after=0&limit=2")
    expect(page.status).toBe(200)
    const entries = Schema.decodeUnknownSync(Schema.Array(RayaAdminLog.Entry))(await page.json())
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2])
    expect(entries.every((entry) => entry.fields?.source === "registry")).toBe(true)

    const cursor = entries.at(1)?.seq
    if (cursor === undefined) throw new Error("Expected the first diagnostic page to contain two entries.")
    const next = await request(`/raya/admin/logs?after=${cursor}&limit=2`)
    expect(next.status).toBe(200)
    const following = Schema.decodeUnknownSync(Schema.Array(RayaAdminLog.Entry))(await next.json())
    expect(following.map((entry) => entry.seq)).toEqual([3, 4])

    const isolated = await request("/raya/admin/logs", second.path)
    expect(isolated.status).toBe(200)
    expect(await isolated.json()).toEqual([])

    const dir = path.join(root.path, "storage", "raya")
    await mkdir(dir, { recursive: true })
    await Bun.write(
      path.join(dir, "agent.json"),
      JSON.stringify({
        path: "C:/private/workspace",
        message: "synthetic-task-secret",
        authorization: "Bearer synthetic-token",
      }),
    )

    const failed = await request("/raya/admin/health")
    expect(failed.status).toBe(200)
    const text = await failed.text()
    const degraded = Schema.decodeUnknownSync(RayaAdmin.Snapshot)(JSON.parse(text))
    expect(degraded.items.map((row) => [row.id, row.status, row.reason])).toEqual([
      ["runtime", "healthy", "ready"],
      ["sessions", "healthy", "ready"],
      ["routines", "unknown", "probe-failed"],
      ["agents", "unknown", "probe-failed"],
      ["browser", "unknown", "not-checked"],
      ["voice", "unknown", "not-checked"],
    ])
    expect(text).not.toContain("synthetic")
    expect(text).not.toContain("private")
    expect(text).not.toContain(first.path)

    expect((await request("/raya/admin/logs?limit=101")).status).toBe(400)
  } finally {
    ;(Global.Path as { data: string }).data = data
    await disposeAllInstances()
  }
}, 30_000)
