import assert from "node:assert/strict"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"

const root = process.argv[2]
assert(root && path.isAbsolute(root))
const file = path.join(root, "model.json")
const lock = await Flock.acquire(`raya.model-state:${process.platform === "win32" ? file.toLowerCase() : file}`, {
  dir: path.join(root, ".raya-model-locks"),
  recover: "dead",
  staleMs: 3600000,
})
console.log("ready")
for await (const bytes of Bun.stdin.stream()) {
  assert.equal(new TextDecoder().decode(bytes).trim(), "release")
  break
}
await lock.release()
console.log("released")
