import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SessionExport } from "@/kilocode/session-export"
import { ProfileParticipants } from "@/kilocode/cli/profile-participants"

const dir = process.argv.at(-1)!
const file = path.join(dir, "export.db")
const ready = Promise.withResolvers<void>()
const options = { agentVersion: "private-cleanup", dbPath: file, subscribeAll: () => () => {} }
SessionExport.init({
  ...options,
  workspaceKey: "first",
  createWorker(url) {
    const worker = new Worker(url)
    worker.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.kind === "ready") ready.resolve()
    })
    worker.addEventListener("error", (event: ErrorEvent) => ready.reject(new Error(event.message)))
    return worker
  },
})
await ready.promise
SessionExport.init({ ...options, workspaceKey: "second" })
const root = await resolveProfileRoot({ kind: "sqlite", path: file })
const locks = path.join(dir, ".raya-profile-locks")
const held = await Flock.acquire(root.id, { dir: locks })
try {
  const first = SessionExport.shutdown()
  assert.equal(SessionExport.shutdown(), first)
  const result = await first.then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.ok(result instanceof AggregateError)
  assert.deepEqual(SessionExport.receipts(), [], "Unconfirmed child roots must not be retained as a confirmed receipt")
  assert.deepEqual(ProfileParticipants.snapshot(), [], "Failed child shutdown cannot publish root metadata")
  assert.ok(result.errors.some((err) => String(err).includes("worker") || String(err).includes("refused")))
  assert.equal(result.errors.filter((err) => String(err).includes("sequencer close failed for first:")).length, 1)
  assert.equal(result.errors.filter((err) => String(err).includes("sequencer close failed for second:")).length, 1)
  assert.equal(SessionExport.shutdown(), first)
  assert.equal(
    await first.then(
      () => undefined,
      (err: unknown) => err,
    ),
    result,
  )
  assert.throws(() => SessionExport.init({ ...options, workspaceKey: "late" }), /not confirmed/)
  const owners = await readdir(path.join(locks, `${Hash.fast(root.id)}.owners`))
  assert.ok(owners.length >= 2, "Unclosed native sequencer ownership was incorrectly cleared")
  console.log(JSON.stringify({ sticky: true, retainedNativeOwners: owners.length, failures: result.errors.length }))
} finally {
  await held.release()
}
