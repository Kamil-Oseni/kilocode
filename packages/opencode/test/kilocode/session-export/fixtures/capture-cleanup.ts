import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { Hash } from "@opencode-ai/core/util/hash"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SessionExport } from "@/kilocode/session-export"
import { Config } from "@/kilocode/session-export/config"

const dir = process.argv.at(-2)!
const mode = process.argv.at(-1)!
assert.ok(mode === "held" || mode === "timeout")
Object.assign(Config, { shutdownFlushTimeoutMs: 20 })
const file = path.join(dir, "export.db")
const ready = Promise.withResolvers<void>()
const started = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const finished = Promise.withResolvers<void>()
const primary = new Error("unsubscribe primary failure")
SessionExport.init({
  agentVersion: "private-capture-cleanup",
  dbPath: file,
  subscribeAll: () => () => {
    assert.equal(SessionExport.shutdown(), first, "Reentrant unsubscribe must join the cached shutdown")
    throw primary
  },
  snapshotProvider: {
    async baseline() {
      started.resolve()
      await release.promise
      await Bun.file(file).arrayBuffer()
      finished.resolve()
      return { snapshotId: "held-real-file", files: [] }
    },
    diff: async () => ({ snapshotHash: "unused", diff: [] }),
  },
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
SessionExport.beforeRequest({
  input: {
    model: { api: { npm: "@kilocode/kilo-gateway" }, isFree: true, providerId: "kilo", modelId: "free-1" },
    org: { type: "personal" },
  },
  requestMeta: {
    sessionId: "held",
    rootSessionId: "held",
    requestId: "request",
    userMessageId: "user",
    agent: "build",
    modeId: "build",
  },
  assembled: { system: [], messages: [], tools: {}, permissions: [], params: {} },
})
await started.promise
let settled = false
const first = SessionExport.shutdown()
const result = first.then(
  () => {
    settled = true
    return undefined
  },
  (err: unknown) => {
    settled = true
    return err
  },
)
await Promise.resolve()
await Promise.resolve()
assert.equal(settled, false, "Unsubscribe failure bypassed the accepted capture body")
if (mode === "held") release.resolve()
const error = await result
assert.ok(error instanceof AggregateError)
assert.ok(error.errors.includes(primary), "The primary unsubscribe error was replaced")
assert.equal(SessionExport.shutdown(), first)
const retained = error.errors.some((err) => String(err).includes("capture bodies have not settled"))
assert.equal(retained, mode === "timeout")
if (mode === "timeout") {
  const root = await resolveProfileRoot({ kind: "sqlite", path: file })
  const owners = await readdir(path.join(dir, ".raya-profile-locks", `${Hash.fast(root.id)}.owners`))
  assert.ok(owners.length > 0, "An unsettled capture's native sequencer ownership was cleared")
  release.resolve()
}
await finished.promise
console.log(JSON.stringify({ mode, retained, primary: true, joined: mode === "held" }))
