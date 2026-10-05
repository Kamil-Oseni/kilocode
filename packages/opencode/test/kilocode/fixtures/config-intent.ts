import assert from "node:assert/strict"
import { prepare, verify } from "../../../../core/test/kilocode/fixtures/config-intent-data"
const [root, mode] = process.argv.slice(2)
const cfg = await prepare(root, mode)
const directory = cfg.workspace.replaceAll("\\", "/")
const { Server } = await import("../../../src/server/server")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { finish } = await import("../../../src/kilocode/cli/finish")
try {
  const response = await Server.Default().app.request(`/config?directory=${encodeURIComponent(directory)}`, {
    headers: { "x-kilo-directory": directory },
  })
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.equal(value.model, mode === "v1-virtual" ? "provider/virtual" : "provider/project")
  await verify(root, mode, cfg)
  console.log("CONFIG_INTENT_PASS")
} finally {
  await finish([
    async () => {
      if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
    },
  ])
}
