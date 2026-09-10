import assert from "node:assert/strict"
import { createRoot, createSignal } from "solid-js"
import { createVoiceRecovery } from "../../webview-ui/src/context/voice-recovery.ts"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
let release
let reject
let stops = 0
let failures = 0
let dispose
const value = createRoot((cleanup) => {
  dispose = cleanup
  const [session, setSession] = createSignal("parent")
  const recovery = createVoiceRecovery(
    session,
    () => {
      stops++
      return new Promise((resolve, fail) => {
        release = resolve
        reject = fail
      })
    },
    () => failures++,
  )
  return { recovery, setSession }
})
try {
  const recovery = value.recovery
  assert.equal(recovery.blocked(), false)
  recovery.bind({ id: "first", session: "parent" })
  assert.equal(recovery.blocked(), true)
  assert.equal(recovery.state(), undefined)
  recovery.acknowledge("first")
  recovery.close()
  recovery.close()
  assert.equal(stops, 1)
  recovery.acknowledge("unrelated")
  assert.equal(recovery.state().host, "pending")
  recovery.acknowledge("first")
  assert.equal(recovery.state().ready, false)
  release()
  await tick()
  assert.equal(recovery.state().ready, true)
  assert.equal(recovery.fail("first"), false)
  recovery.bind({ id: "second", session: "parent" })
  recovery.close()
  release()
  await tick()
  assert.equal(recovery.state().local, "ready")
  assert.equal(recovery.state().ready, false)
  assert.equal(recovery.fail("unrelated"), false)
  assert.equal(recovery.fail("second"), true)
  assert.equal(recovery.state().host, "failed")
  assert.equal(recovery.blocked(), true)
  recovery.acknowledge("first")
  assert.equal(recovery.blocked(), true)
  recovery.acknowledge("second")
  assert.equal(recovery.blocked(), false)
  recovery.bind({ id: "third", session: "parent" })
  recovery.close()
  reject(new Error("local release failed"))
  await tick()
  recovery.acknowledge("third")
  assert.equal(recovery.state().local, "failed")
  assert.equal(recovery.blocked(), true)
  assert.equal(failures, 1)
  value.setSession("other")
  await tick()
  assert.equal(recovery.state(), undefined)
  assert.equal(recovery.blocked(), true)
  value.setSession("parent")
  await tick()
  assert.equal(recovery.state(), undefined)
  console.log("Voice recovery: 22 production-state assertions passed")
} finally {
  dispose()
}
