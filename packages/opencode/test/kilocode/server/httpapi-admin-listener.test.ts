import { expect, test } from "bun:test"
import { Schema } from "effect"
import { RayaAdmin } from "@/kilocode/admin/registry"
import { Server } from "@/server/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

test("the production listener starts with the shared Canvas service and serves Admin health", async () => {
  await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })

  try {
    const response = await fetch(new URL("/raya/admin/health", listener.url), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const snapshot = Schema.decodeUnknownSync(RayaAdmin.Snapshot)(await response.json())
    expect(snapshot.items.find((row) => row.id === "canvas")).toMatchObject({
      status: "healthy",
      reason: "ready",
    })
  } finally {
    await listener.stop(true)
    await disposeAllInstances()
  }
}, 30_000)
