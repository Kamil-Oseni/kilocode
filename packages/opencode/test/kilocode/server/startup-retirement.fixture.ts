import assert from "node:assert/strict"
import path from "node:path"
import { Server } from "@/server/server"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { finish } from "@/kilocode/cli/finish"

const root = process.env.RAYA_RETIREMENT_PROFILE
assert.ok(root)
const directory = path.join(root, "workspace")
const response = await Server.Default().app.request(`/session?directory=${encodeURIComponent(directory)}&roots=true`)
assert.equal(response.status, 200, await response.clone().text())
assert.deepEqual(await response.json(), [])
await finish(
  [
    async () => {
      if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
    },
  ],
  () => Bun.write(path.join(root, "receipt.json"), JSON.stringify({ passed: true, pid: process.pid })).then(() => {}),
)
