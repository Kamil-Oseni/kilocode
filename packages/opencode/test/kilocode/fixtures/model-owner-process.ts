import path from "node:path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { createVariantRuntime } from "@/cli/cmd/run/variant.shared"
import { ModelOwner } from "@/kilocode/config/model-owner"
import assert from "node:assert/strict"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

const [mode, root] = process.argv.slice(2)
assert(root && path.isAbsolute(root))
Global.Path.state = root
if (mode === "lock") {
  const file = path.join(root, "model.json")
  const lock = await Flock.acquire(`raya.model-state:${process.platform === "win32" ? file.toLowerCase() : file}`, {
    dir: path.join(root, ".raya-model-locks"),
  })
  console.log("ready")
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).trim() === "release") break
  }
  await lock.release()
  console.log("released")
} else {
  assert.equal(mode, "runtime")
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let enter!: () => void
  const started = new Promise<void>((resolve) => {
    enter = resolve
  })
  const events: string[] = []
  const layer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      enter()
      yield* Effect.promise(() => gate)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          assert.equal((await Bun.file(path.join(root, "model.json")).json()).variant["actual/model"], "none")
          events.push("dispose")
        }),
      )
      return fs
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  const runtime = createVariantRuntime(layer)
  const write = runtime.saveVariant({ providerID: "actual", modelID: "model" }, "none")
  assert.equal(ModelOwner.process.snapshot().active, 1)
  await started
  let settled = false
  const retired = RuntimeRegistry.drain().then(() => {
    settled = true
  })
  await Bun.sleep(40)
  assert.equal(settled, false)
  assert.equal(await Bun.file(path.join(root, "model.json")).exists(), false)
  release()
  await write
  await retired
  assert.equal(ModelOwner.process.snapshot().active, 0)
  assert.deepEqual(events, ["dispose"])
  await closeProcessProfile()
  console.log(JSON.stringify({ passed: true, events, active: 0 }))
}
