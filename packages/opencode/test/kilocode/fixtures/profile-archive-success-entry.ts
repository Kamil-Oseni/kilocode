import assert from "node:assert/strict"
import path from "node:path"
import { existsSync } from "node:fs"

const root = process.env.RAYA_TEST_ARCHIVE_ROOT
assert(root && path.isAbsolute(root) && path.basename(root).startsWith("raya-archive-success-"))
const marker = path.join(root, "preparation-failed")
const deadline = Date.now() + 120000
let sent = false
// Exercise the actual supported Serve signal owner, never native force/abort or a fabricated capture receipt.
const timer = setInterval(() => {
  if (sent || (!existsSync(marker) && Date.now() < deadline) || !process.listenerCount("SIGINT")) return
  sent = true
  process.emit("SIGINT", "SIGINT")
}, 100)
try {
  await import("../../../src/index")
} finally {
  clearInterval(timer)
}
