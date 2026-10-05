import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { closeProcessProfile, sourceScopes } from "@opencode-ai/core/kilocode/process-profile"

const [root, ...directories] = process.argv.slice(2)
assert.ok(root && path.isAbsolute(root) && directories.length === 2)
for (const data of directories) {
  await mkdir(path.join(data, "state"), { recursive: true })
  Global.make({
    data,
    home: data,
    cache: data,
    config: data,
    state: path.join(data, "state"),
    bin: data,
    log: data,
    repos: data,
    tmp: path.join(root, "tmp"),
  })
}
await closeProcessProfile()
const scopes = sourceScopes()
assert.equal(scopes.version, 4)
assert.ok("globals" in scopes)
const globals = scopes.globals.filter((item) => directories.includes(item.data))
assert.equal(globals.length, 2)
await writeFile(path.join(root, "secondary-globals.json"), JSON.stringify(globals), { flag: "wx" })
