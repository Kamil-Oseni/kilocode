import assert from "node:assert/strict"
import { SessionExport } from "@/kilocode/session-export"
import { Config } from "@/kilocode/session-export/config"
import { getKillSwitchReason } from "@/kilocode/session-export/eligibility"

const mode = process.argv.at(-1)
assert.ok(mode === "wrong" || mode === "timeout" || mode === "capture")
if (mode === "timeout" || mode === "capture") Object.assign(Config, { shutdownFlushTimeoutMs: 20 })

class WorkerFixture {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  posts = 0

  postMessage(msg: { kind?: string; requestID?: string }) {
    if (msg.kind !== "shutdown") return
    this.posts++
    this.onmessage?.({
      data: { kind: "shutdown_done", requestID: crypto.randomUUID(), status: "confirmed" },
    } as MessageEvent)
    if (mode === "wrong")
      this.onmessage?.({
        data: { kind: "shutdown_refused", requestID: msg.requestID, reason: "held drain" },
      } as MessageEvent)
  }

  terminate() {
    this.terminated = true
  }
}

const fixture = new WorkerFixture()
SessionExport.init({
  agentVersion: "test",
  dbPath: ":memory:",
  syncSeq: () => 1,
  subscribeAll: () => () => {},
  createWorker: () => fixture as unknown as Worker,
  snapshotProvider:
    mode === "capture"
      ? {
          baseline: () => new Promise(() => {}),
          diff: async () => ({ snapshotHash: "unused", diff: [] }),
        }
      : undefined,
})
if (mode === "capture")
  SessionExport.beforeRequest({
    input: {
      model: { api: { npm: "@kilocode/kilo-gateway" }, isFree: true, providerId: "kilo", modelId: "free-1" },
      org: { type: "personal" },
    },
    requestMeta: {
      sessionId: "s1",
      rootSessionId: "s1",
      requestId: "r1",
      userMessageId: "u1",
      agent: "build",
      modeId: "build",
    },
    assembled: { system: [], messages: [], tools: {}, permissions: [], params: {} },
  })
const first = SessionExport.shutdown()
const second = SessionExport.shutdown()
const results = await Promise.allSettled([first, second])
assert.equal(results[0].status, "rejected")
assert.equal(results[1].status, "rejected")
assert.match(
  String((results[0] as PromiseRejectedResult).reason),
  mode === "wrong" ? /refused: held drain/ : /timed out/,
)
assert.equal(fixture.posts, mode === "capture" ? 0 : 1)
assert.equal(fixture.terminated, true)
assert.equal(getKillSwitchReason(), "session_export_shutdown_unconfirmed")
await assert.rejects(SessionExport.shutdown(), /shutdown is not confirmed/)
assert.throws(
  () =>
    SessionExport.init({
      agentVersion: "test",
      dbPath: ":memory:",
      subscribeAll: () => () => {},
      createWorker: () => fixture as unknown as Worker,
    }),
  /shutdown is not confirmed/,
)
console.log(JSON.stringify({ mode, refused: true, terminated: fixture.terminated, posts: fixture.posts }))
process.exit(0)
