import assert from "node:assert/strict"
import path from "node:path"
import { withRetirement, assertRetirement } from "../../../src/kilocode/migration/source-host"
import { isRetired } from "@opencode-ai/core/kilocode/source-launch"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
const control = process.env.RAYA_SOURCE_HANDOFF_CONTROL!
let expired: object | undefined
await withRetirement(async (token) => {
  expired = token
  const closure = assertRetirement(token)
  assert.equal(isRetired(closure.proof), true)
  assert.equal(closure.proof.familyZeroObserved, true)
  assert.equal(closure.seed.length, 1)
  assert.ok(closure.roots.length > closure.seed.length)
  assert.equal(Object.isFrozen(closure), true)
  assert.equal(Object.isFrozen(closure.roots), true)
  assert.throws(() => assertRetirement({ ...token }))
  await Bun.write(
    path.join(control, "callback.json"),
    JSON.stringify({
      live: true,
      seed: closure.seed,
      roots: closure.roots,
      policy: closure.policy,
      members: closure.proof.members.map((member) => member.pid),
      completeProfileCoverage: false,
      portableCaptureAuthorized: false,
    }),
  )
  while (!(await Bun.file(path.join(control, "release-callback")).exists())) await Bun.sleep(25)
  assert.equal(assertRetirement(token), closure)
})
assert.throws(() => assertRetirement(expired))
await Bun.write(path.join(control, "expired.json"), JSON.stringify({ expired: true }))
await closeProcessProfile()
process.exit()
