import assert from "node:assert/strict"
import path from "node:path"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { ProfileParticipants } from "../../../src/kilocode/cli/profile-participants"

const root = process.env.RAYA_INDEXING_TEST_ROOT!
const mode = process.env.RAYA_INDEXING_TEST_MODE
Object.assign(globalThis, {
  KILO_INDEXING_WORKER_PATH: new URL("./indexing-retirement-worker.ts", import.meta.url).href,
})
const { IndexingWorker } = await import("../../../src/kilocode/indexing-worker-client")
const hooks = {
  status() {},
  telemetry() {},
  warning() {},
  log() {},
  failure(err: unknown) {
    throw err
  },
}
const engine = IndexingWorker.create(root, root, hooks)
const wait = async (name: string) => {
  const until = Date.now() + 5000
  while (!(await Bun.file(path.join(root, name)).exists())) {
    if (Date.now() > until) throw new Error(`Missing ${name}`)
    await Bun.sleep(10)
  }
}
await wait("ready")
assert.equal((await engine.init({ enabled: false, embedderProvider: "openai" })).state, "Disabled")
await assert.rejects(
  coordinateNativeRoots([{ kind: "json", path: root }], async () => undefined),
  /remain live/,
)
const closed = IndexingWorker.shutdown()
assert.equal(closed, IndexingWorker.shutdown())
let settled = false
void closed.then(
  () => {
    settled = true
  },
  () => {
    settled = true
  },
)
assert.throws(() => IndexingWorker.create(root, root, hooks), /closed/)
await assert.rejects(engine.search("late"), /closed/)
await wait("entered")
if (mode === "held") {
  try {
    await Bun.sleep(100)
    assert.equal(settled, false)
    assert.equal(ProfileParticipants.snapshot().length, 0)
    assert.equal(await Bun.file(path.join(root, "closed")).exists(), false)
  } finally {
    await Bun.write(path.join(root, "release"), "release")
  }
}
if (mode === "failed") {
  await assert.rejects(closed, /unconfirmed/)
  assert.equal(ProfileParticipants.snapshot().length, 0)
  await assert.rejects(
    coordinateNativeRoots([{ kind: "json", path: root }], async () => undefined),
    /remain live/,
  )
} else {
  const receipts = await closed
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0]?.role, "indexing-worker")
  assert.equal(ProfileParticipants.snapshot().length, 1)
  assert.equal(await Bun.file(path.join(root, "native.log")).text(), "RAYA_INDEX_NATIVE_FINAL_MARKER\n")
  await coordinateNativeRoots(receipts[0]!.receipt.roots, async (admission) => {
    assert.equal(admission.nativeOwners, 0)
    assert.equal(admission.operations, 0)
  })
}
await Bun.write(
  path.join(root, "receipt.json"),
  JSON.stringify({ passed: true, mode, portable: false, refused: mode === "failed" }),
)
