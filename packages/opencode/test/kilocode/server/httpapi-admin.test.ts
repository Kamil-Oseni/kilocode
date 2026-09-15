import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Schema } from "effect"
import { RayaAdminLog } from "@/kilocode/admin/log"
import { RayaAdmin } from "@/kilocode/admin/registry"
import { RayaMigrationLedger } from "@/kilocode/migration/compatibility"
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

    const migration = await request("/raya/admin/migration")
    expect(migration.status).toBe(200)
    const ledger = Schema.decodeUnknownSync(RayaMigrationLedger.Snapshot)(await migration.json())
    expect(ledger.entries.every((item) => item.cutoverReady === false)).toBe(true)
    expect(ledger.entries.find((item) => item.id === "editor-distribution")?.phase).toBe("deferred-version-3")
    expect(JSON.stringify(ledger)).not.toContain(first.path)

    const recent = await request("/raya/admin/logs?limit=2")
    expect(recent.status).toBe(200)
    const latest = Schema.decodeUnknownSync(Schema.Array(RayaAdminLog.Entry))(await recent.json())
    expect(latest.map((entry) => [entry.seq, entry.subsystem, entry.code])).toEqual([
      [7, "agents", "probe.completed"],
      [8, "routines", "probe.completed"],
    ])

    const page = await request("/raya/admin/logs?after=0&limit=2")
    expect(page.status).toBe(200)
    const entries = Schema.decodeUnknownSync(Schema.Array(RayaAdminLog.Entry))(await page.json())
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2])
    expect(entries.map((entry) => entry.code)).toEqual(["probe.started", "probe.started"])
    expect(entries.map((entry) => entry.subsystem)).toEqual(["runtime", "sessions"])
    expect(entries.every((entry) => entry.fields?.source === "registry")).toBe(true)

    const cursor = entries.at(1)?.seq
    if (cursor === undefined) throw new Error("Expected the first diagnostic page to contain two entries.")
    const next = await request(`/raya/admin/logs?after=${cursor}&limit=2`)
    expect(next.status).toBe(200)
    const following = Schema.decodeUnknownSync(Schema.Array(RayaAdminLog.Entry))(await next.json())
    expect(following.map((entry) => entry.seq)).toEqual([3, 4])
    expect(following.map((entry) => entry.subsystem)).toEqual(["routines", "agents"])

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

    const failures = Schema.decodeUnknownSync(Schema.Array(RayaAdminLog.Entry))(
      await (await request("/raya/admin/logs?limit=2")).json(),
    )
    expect(failures.map((entry) => entry.code)).toEqual(["probe.failed", "probe.failed"])
    expect(failures.map((entry) => entry.subsystem).sort()).toEqual(["agents", "routines"])
    expect(JSON.stringify(failures)).not.toContain("synthetic")
    expect(JSON.stringify(failures)).not.toContain("private")

    expect((await request("/raya/admin/logs?limit=101")).status).toBe(400)

    await disposeAllInstances()
    const restarted = await request("/raya/admin/logs")
    expect(restarted.status).toBe(200)
    expect(await restarted.json()).toEqual([])
  } finally {
    ;(Global.Path as { data: string }).data = data
    await disposeAllInstances()
  }
}, 30_000)
