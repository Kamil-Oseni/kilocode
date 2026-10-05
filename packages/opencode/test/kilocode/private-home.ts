import assert from "node:assert/strict"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdir } from "node:fs/promises"

const root = path.resolve(tmpdir(), `opencode-test-data-${process.pid}`)
assert.equal(path.dirname(root), path.resolve(tmpdir()))
for (const [key, leaf] of [
  ["HOME", "home"],
  ["USERPROFILE", "home"],
  ["APPDATA", "roaming"],
  ["LOCALAPPDATA", "local"],
] as const) {
  const dir = path.join(root, leaf)
  await mkdir(dir, { recursive: true })
  process.env[key] = dir
}
