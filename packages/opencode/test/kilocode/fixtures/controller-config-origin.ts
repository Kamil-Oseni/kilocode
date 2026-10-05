import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { prepare } from "../../../../core/test/kilocode/fixtures/config-intent-data"
import { participantScopes } from "../../../src/kilocode/cli/profile-participants"

const [root, mode] = process.argv.slice(2)
assert.ok(root && (mode === "v1" || mode === "v1-virtual"))
const cfg = await prepare(root, mode)
await writeFile(cfg.first, JSON.stringify({ enabled_providers: [], permission: "deny", formatter: false, lsp: false }))
const { Server } = await import("../../../src/server/server")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { finish } = await import("../../../src/kilocode/cli/finish")
try {
  const response = await Server.Default().app.request(`/config?directory=${encodeURIComponent(cfg.workspace)}`, {
    headers: { "x-kilo-directory": cfg.workspace },
  })
  assert.equal(response.status, 200)
  await finish(
    [
      async () => {
        if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
      },
    ],
    () => {
      if (mode === "v1-virtual") {
        assert.throws(() => participantScopes(true), /confirmed configuration origin/)
        const value = participantScopes(false)
        assert.equal(value.version, 4)
        assert.ok("configStatus" in value && value.configStatus === "uncertain")
        assert.ok("configReason" in value && value.configReason === "origin-uncertain")
        console.log("CONTROLLER_CONFIG_VIRTUAL_REFUSED")
      } else {
        const value = participantScopes(true)
        assert.equal(value.version, 4)
        assert.ok("configStatus" in value && value.configStatus === "complete")
        console.log("CONTROLLER_CONFIG_PHYSICAL_COMPLETE")
      }
    },
  )
} finally {
  await finish([
    async () => {
      if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
    },
  ])
}
