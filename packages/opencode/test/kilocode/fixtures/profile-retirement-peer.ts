import assert from "node:assert/strict"
import path from "node:path"
import { Database } from "bun:sqlite"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"

const dir = process.argv[2]
const owner = profileSqlite(path.join(dir, "first.db"), (file) => new Database(file))
try {
  await Bun.write(path.join(dir, "peer-ready"), "ready")
  const deadline = performance.now() + 10_000
  while (!(await Bun.file(path.join(dir, "peer-release")).exists())) {
    assert.ok(performance.now() < deadline, "Peer owner release was not received")
    await Bun.sleep(10)
  }
} finally {
  owner.close()
}
console.log(JSON.stringify({ closed: true }))
