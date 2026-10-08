import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
import path from "node:path"
import { registerProfileFile } from "../../../src/kilocode/profile-maintenance"
import { birth } from "../../../src/kilocode/profile-owner"

const dir = process.argv[2]
const owner = registerProfileFile({ kind: "json", path: path.join(dir, "payload") })
try {
  await writeFile(path.join(dir, "ready"), JSON.stringify({ pid: process.pid, birth: birth() }))
  const stop = performance.now() + 10_000
  while (!existsSync(path.join(dir, "release"))) {
    if (performance.now() >= stop) throw new Error("Node profile owner fixture release deadline elapsed")
    await setTimeout(10)
  }
} finally {
  owner.release()
}
