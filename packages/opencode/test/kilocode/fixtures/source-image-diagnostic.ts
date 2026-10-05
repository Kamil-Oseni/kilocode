import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { image } from "../../../src/kilocode/daemon/ownership"
import { failure } from "../../../src/kilocode/migration/source-failure"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

const root = process.env.KILO_TEST_HOME
if (!root) throw new Error("Private image fixture root missing")
const state = { passed: false, child: 0, code: -1, current: false, probe: false, forced: false }
try {
  const own = await image(process.pid)
  assert.equal(own.executable, (await realpath(process.execPath)).toLowerCase())
  assert.equal(
    own.digest,
    createHash("sha256")
      .update(Buffer.from(await Bun.file(process.execPath).arrayBuffer()))
      .digest("hex"),
  )
  assert.match(own.birth, /^\d{1,20}$/)
  state.current = true
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  state.child = child.pid
  state.code = await child.exited
  assert.equal(state.code, 0)
  assert.throws(() => process.kill(child.pid, 0))
  await assert.rejects(image(child.pid), (err: unknown) => {
    const diagnostic = failure(err)
    assert.equal(diagnostic.errors[0]?.code, "RAYA_SOURCE_IMAGE_PROBE_REFUSED")
    assert(!JSON.stringify(diagnostic).includes(root))
    assert(err instanceof Error && err.cause instanceof Error)
    state.probe = true
    return true
  })
  state.passed = true
} finally {
  await closeProcessProfile()
  await Bun.write(path.join(root, "receipt.json"), JSON.stringify(state))
}
