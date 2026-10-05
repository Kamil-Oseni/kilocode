import assert from "node:assert/strict"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { Flock } from "@opencode-ai/core/util/flock"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { TuiPathsProvider } from "../../../src/context/runtime"
import { KVProvider, useKV } from "../../../src/context/kv"

const dir = process.argv[2]
const state = path.join(dir, "state")
const ready = Promise.withResolvers<ReturnType<typeof useKV>>()
function Probe() {
  const kv = useKV()
  ready.resolve(kv)
  return <text>Private KV lifecycle check</text>
}
const app = await testRender(
  () => (
    <TuiPathsProvider value={{ cwd: dir, home: dir, state, worktree: dir }}>
      <KVProvider>
        <Probe />
      </KVProvider>
    </TuiPathsProvider>
  ),
  { width: 40, height: 3 },
)
const kv = await ready.promise
const held = await Flock.acquire(`tui-kv:${path.join(state, "kv.json")}`, { dir: path.join(state, "locks") })
let released: Promise<void> | undefined
const unlock = () => (released ??= held.release())
try {
  kv.set("preference", "durable")
  app.renderer.destroy()
  assert.throws(() => kv.set("late", "refused"), /retired/)
  const closing = RuntimeRegistry.drain()
  assert.equal(RuntimeRegistry.drain(), closing)
  let settled = false
  void closing.then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)
  await unlock()
  await closing
  assert.deepEqual(await Bun.file(path.join(state, "kv.json")).json(), { preference: "durable" })
  assert.throws(() => RuntimeRegistry.check(), /closed/)
  console.log("production KV provider cutoff, accepted write, cleanup and global drain passed")
} finally {
  await unlock()
  app.renderer.destroy()
}
