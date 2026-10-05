import assert from "node:assert/strict"
import { join } from "node:path"

const root = process.env.RAYA_RETIREMENT_PROFILE
assert.ok(root, "The parent must provide a private profile")
const receipt = join(root, "receipt.json")
const api = await import("../../../src/server/routes/instance/httpapi/server")
const server = await import("../../../src/server/server")
const runtime = await import("../../../src/effect/app-runtime")

try {
  const app = server.Default().app
  const response = await app.request("/kilocode/capabilities")
  assert.equal(response.status, 200)
  assert.equal((await response.json()).version, 1)
  const handler = api.webHandler()
  const closed = handler.dispose()
  assert.equal(api.webHandler(), handler)
  assert.equal(handler.dispose(), closed)
  await assert.rejects(async () => app.request("/kilocode/capabilities"), /HTTP handler is retired/)
  await closed
  assert.equal(handler.dispose(), closed)
  await assert.rejects(async () => app.request("/kilocode/capabilities"), /HTTP handler is retired/)
  assert.equal(server.Default().app, app)
  await runtime.AppRuntime.dispose()
  await Bun.write(
    receipt,
    JSON.stringify({ passed: true, pid: process.pid, cached: true, joined: true, pending: true, terminal: true }),
  )
} catch (err) {
  await Bun.write(receipt, JSON.stringify({ passed: false, pid: process.pid, error: String(err) }))
  throw err
}
