import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Database as Native } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"
import { layer } from "@opencode-ai/core/database/sqlite.bun"
import { Sqlite } from "@opencode-ai/core/database/sqlite"
import { admitProfileOperation } from "@opencode-ai/core/kilocode/profile-maintenance"
import { profileSqlite } from "@opencode-ai/core/kilocode/profile-sqlite"
import { makeRuntime } from "../../../src/effect/run-service"
import { retire, receipt } from "../../../src/kilocode/cli/database-retirement"
import { collect } from "../../../src/kilocode/cli/profile-retirement"
import { ProfileRoots } from "@opencode-ai/core/kilocode/profile-roots"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

const mode = process.argv[2]
const dir = process.argv[3]
const baseline = ProfileRoots.snapshot().length
const selected = mode === "retarget" ? path.join(dir, "selected") : dir
await fs.mkdir(selected, { recursive: true })
const files = [path.join(selected, "first.db"), path.join(selected, "second.db")]
const unused = makeRuntime(Sqlite.Native, layer({ filename: path.join(dir, "unused.db") }))
assert.equal(receipt(), undefined)
if (mode !== "empty") {
  for (const file of files) {
    const runtime = makeRuntime(Sqlite.Native, layer({ filename: file }))
    await runtime.runPromise(() => Effect.void)
    if (mode === "retarget") await runtime.dispose()
  }
  const root = { kind: "json" as const, path: path.join(dir, "json") }
  const lease = admitProfileOperation(root)
  await fs.mkdir(root.path)
  await fs.writeFile(path.join(root.path, "actual.json"), "{}")
  lease.release()
}
if (mode === "retarget") {
  const replacement = path.join(dir, "replacement")
  await fs.mkdir(replacement)
  await fs.rename(selected, path.join(dir, "retained"))
  await fs.symlink(replacement, selected, "junction")
  await retire()
  await closeProcessProfile()
  assert.equal(receipt()?.observation, "participating-roots")
  await assert.rejects(collect(), /Historical participating-root identity changed/)
  await assert.rejects(collect(), /Historical participating-root identity changed/)
  assert.equal("nativeOwners" in receipt()!, false)
  assert.equal(await Bun.file(path.join(replacement, "first.db")).exists(), false)
}
if (mode === "failed") {
  class Failed extends Context.Service<Failed, number>()("@test/ProfileRetirementFailed") {}
  const runtime = makeRuntime(
    Failed,
    Layer.effect(
      Failed,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(new Error("actual retirement finalizer failed")))
        return 1
      }),
    ),
  )
  await runtime.runPromise(() => Effect.void)
  await assert.rejects(retire())
  await assert.rejects(retire())
  assert.equal(receipt(), undefined)
}
if (mode !== "failed" && mode !== "retarget") {
  const peer =
    mode === "peer"
      ? Bun.spawn([process.execPath, path.join(import.meta.dir, "profile-retirement-peer.ts"), dir], {
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        })
      : undefined
  const output = peer ? new Response(peer.stdout).text() : undefined
  const errors = peer ? new Response(peer.stderr).text() : undefined
  if (peer) {
    const deadline = performance.now() + 5_000
    while (!(await Bun.file(path.join(dir, "peer-ready")).exists())) {
      assert.ok(performance.now() < deadline, "Peer native owner did not open")
      await Bun.sleep(10)
    }
  }
  const first = retire()
  assert.equal(retire(), first)
  await first
  const result = receipt()!
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.roots))
  assert.equal(result.portableCaptureAuthorized, false)
  assert.equal(result.completeProfileCoverage, false)
  assert.equal(result.processLocal, true)
  assert.equal("nativeOwners" in result, false)
  assert.equal("operations" in result, false)
  assert.equal(result.roots.length, baseline + (mode === "empty" ? 0 : 3))
  await closeProcessProfile()
  if (peer) {
    await assert.rejects(collect(), /remain live/)
    assert.equal(receipt(), result)
    await Bun.write(path.join(dir, "peer-release"), "release")
    assert.equal(await peer.exited, 0, await errors)
    assert.ok((await output)?.includes('"closed":true'))
    assert.throws(() => process.kill(peer.pid, 0), { code: "ESRCH" })
  }
  if (mode === "empty") {
    assert.ok("observation" in result && result.observation === "participating-roots")
    assert.equal("nativeOwners" in result, false)
  } else {
    await collect(async (admission) => {
      assert.ok(Object.isFrozen(admission))
      assert.equal(admission.nativeOwners, 0)
      assert.equal(admission.operations, 0)
      for (const root of admission.roots) {
        const locks = path.join(path.dirname(root.path), ".raya-profile-locks")
        for (const name of await fs.readdir(locks))
          if (name.endsWith(".owners") || name.endsWith(".writers"))
            assert.deepEqual(await fs.readdir(path.join(locks, name)), [])
        assert.throws(() => admitProfileOperation(root), /maintenance/)
        if (root.kind === "sqlite")
          assert.throws(() => profileSqlite(root.path, (file) => new Native(file)), /maintenance/)
      }
      assert.equal(Reflect.set(admission, "nativeOwners", 4), false)
    })
    await assert.rejects(
      collect(async () => {
        throw new Error("receipt observation failed")
      }),
      /receipt observation failed/,
    )
    assert.equal(receipt(), result)
  }
}
assert.equal(await Bun.file(path.join(dir, "unused.db")).exists(), false)
await unused.dispose()
console.log(JSON.stringify({ mode, receipt: receipt() ?? null, unused: false }))
