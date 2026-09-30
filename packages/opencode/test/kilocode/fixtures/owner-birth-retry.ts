import assert from "node:assert/strict"
import { mock } from "bun:test"
import * as native from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

assert.equal(process.platform, "win32")
const spawn = native.spawnSync
let calls = 0
let nested: (() => void) | undefined
mock.module("node:child_process", () => ({
  ...native,
  spawnSync: (...args: Parameters<typeof native.spawnSync>) => {
    if (args[0] !== "powershell.exe") return spawn(...args)
    calls++
    nested?.()
    if (calls === 1) return { status: null, error: new Error("Synthetic birth probe timeout"), stdout: "" }
    if (calls === 2) throw new Error("Synthetic birth probe launch failure")
    if (calls === 3) return { status: 0, stdout: "malformed native identity" }
    return spawn(...args)
  },
}))

const { durable, stopped } = await import("../../../src/kilocode/task/owner")
const dir = await mkdtemp(join(tmpdir(), "raya-owner-retry-"))
process.env.KILO_TEST_HOME = dir
process.env.XDG_STATE_HOME = join(dir, "state")
process.env.XDG_DATA_HOME = join(dir, "data")
process.env.XDG_CACHE_HOME = join(dir, "cache")
process.env.XDG_CONFIG_HOME = join(dir, "config")
const { Effect, Exit, Layer } = await import("effect")
const { Storage } = await import("../../../src/storage/storage")
const { FSUtil } = await import("@opencode-ai/core/fs-util")
const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
const { Git } = await import("../../../src/git")
const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
const { RayaTaskExecution } = await import("../../../src/kilocode/task/execution")
const { SessionID } = await import("../../../src/session/schema")
const layer = Storage.layerFromDir(join(dir, "storage")).pipe(
  Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
)
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const execution = RayaTaskExecution.make(storage)
      const run = { id: "retry-terminal", agentID: "retry-worker", sessionID: SessionID.make("ses_retry_terminal") }
      yield* storage.list(["raya", "agent-executions"])
      yield* Effect.promise(async () => {
        nested = () => assert.equal(durable().birth, undefined, "A reentrant probe acquired an identity")
        const refused = await Effect.runPromise(execution.terminal(run).pipe(Effect.exit))
        assert.ok(Exit.isFailure(refused), "Unknown process birth admitted terminal recovery")
        assert.deepEqual(await Effect.runPromise(storage.list(["raya", "agent-executions"])), [])
        for (const attempt of Array.from({ length: 16 }, (_, index) => index)) {
          assert.equal(durable().birth, undefined, `Attempt ${attempt} did not remain uncertain`)
          assert.equal(stopped({ ...durable(), birth: "unknown-prior-birth" }), false)
        }
        assert.equal(calls, 1, "Failed probes were retried without a cooldown")
        for (const count of [2, 3]) {
          await Bun.sleep(1_100)
          assert.equal(durable().birth, undefined)
          assert.equal(calls, count)
          assert.equal(durable().birth, undefined)
          assert.equal(calls, count, "Repeated failures bypassed the cooldown")
        }
        await Bun.sleep(1_100)
        const identity = durable()
        assert.ok(identity.birth, "A failed first probe was cached permanently")
        assert.equal(calls, 4)
        assert.equal(stopped(identity), false)
        assert.equal(stopped({ ...identity, birth: `${identity.birth}-older` }), true)
        for (const attempt of Array.from({ length: 16 }, (_, index) => index)) {
          assert.deepEqual(durable(), identity, `Successful identity changed at attempt ${attempt}`)
        }
        assert.equal(calls, 4, "Successful process identity was not cached")
        const permit = await Effect.runPromise(execution.terminal(run))
        assert.ok(permit, "Verified process identity could not acquire terminal recovery")
        let effects = 0
        await Effect.runPromise(
          execution.recover(
            permit,
            Effect.sync(() => effects++),
          ),
        )
        assert.equal(effects, 1)
        assert.deepEqual(await Effect.runPromise(storage.list(["raya", "agent-executions"])), [])
      })
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
} finally {
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
  await rm(dir, { recursive: true, force: true })
}
console.log("birth retry passed")
