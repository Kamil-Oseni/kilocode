import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { Hash } from "@opencode-ai/core/util/hash"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SessionExport } from "@/kilocode/session-export"
import { ProfileParticipants } from "@/kilocode/cli/profile-participants"

const dir = process.argv.at(-1)!
const file = path.join(dir, "export.db")
const ready = Promise.withResolvers<void>()
assert.deepEqual(SessionExport.receipts(), [])
assert.deepEqual(ProfileParticipants.snapshot(), [])
let forced = 0
let closed: Event | undefined
SessionExport.init({
  agentVersion: "private-natural-parent",
  dbPath: file,
  workspaceKey: "first",
  subscribeAll: () => () => {},
  createWorker(url) {
    const worker = new Worker(url)
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => {
      forced += 1
      terminate()
    }
    worker.addEventListener("message", (event: MessageEvent<{ kind: string }>) => {
      if (event.data.kind === "ready") ready.resolve()
    })
    worker.addEventListener("close", (event) => {
      closed = event
    })
    worker.addEventListener("error", (event: ErrorEvent) => ready.reject(new Error(event.message)))
    return worker
  },
})
await ready.promise
SessionExport.init({
  agentVersion: "private-natural-parent",
  dbPath: file,
  workspaceKey: "second",
  subscribeAll: () => () => {},
})
const root = await resolveProfileRoot({ kind: "sqlite", path: file })
const locks = path.join(dir, ".raya-profile-locks")
assert.equal((await readdir(path.join(locks, `${Hash.fast(root.id)}.owners`))).length, 3)
const first = SessionExport.shutdown()
assert.deepEqual(
  ProfileParticipants.snapshot(),
  [],
  "Child metadata cannot be remembered before acknowledgment and exit",
)
assert.equal(SessionExport.shutdown(), first)
await first
assert.ok(closed && "code" in closed && closed.code === 0 && "wasClean" in closed && closed.wasClean === true)
assert.equal(forced, 0, "Successful parent shutdown forced worker termination")
assert.deepEqual(await readdir(path.join(locks, `${Hash.fast(root.id)}.owners`)), [])
assert.deepEqual(await readdir(path.join(locks, `${Hash.fast(root.id)}.writers`)), [])
assert.equal(SessionExport.shutdown(), first)
const receipt = SessionExport.receipts()[0]
assert.equal(SessionExport.receipts().length, 1)
assert.ok(
  Object.isFrozen(SessionExport.receipts()) && Object.isFrozen(receipt) && Object.isFrozen(receipt.receipt.roots),
)
assert.equal(receipt.role, "session-export-worker")
assert.equal(receipt.receipt.processLocal, true)
assert.equal(receipt.receipt.completeProfileCoverage, false)
assert.equal(receipt.receipt.portable, false)
assert.equal("nativeOwners" in receipt.receipt, false)
assert.equal("operations" in receipt.receipt, false)
assert.deepEqual(receipt.receipt.roots, [{ kind: "sqlite", path: file }])
assert.equal(SessionExport.receipts()[0], receipt)
assert.deepEqual(ProfileParticipants.snapshot(), [
  {
    role: receipt.role,
    runID: receipt.runID,
    generation: receipt.generation,
    requestID: receipt.requestID,
    receipt: receipt.receipt,
  },
])
console.log(JSON.stringify({ natural: true, forced, nativeOwners: 0, operations: 0 }))
