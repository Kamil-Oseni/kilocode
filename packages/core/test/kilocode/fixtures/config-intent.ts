import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { prepare, verify } from "./config-intent-data"
const [root, mode] = process.argv.slice(2)
const cfg = await prepare(root, mode)
const { global, workspace, schema } = cfg
const { Effect, Layer, ManagedRuntime } = await import("effect")
const { Global } = await import("../../../src/global")
const { closeProcessProfile } = await import("../../../src/kilocode/process-profile")
if (mode === "lifecycle") {
  await import("./config-intent-lifecycle")
  process.exit(0)
}
if (mode.startsWith("v2")) {
  const { Config } = await import("../../../src/config")
  const { Policy } = await import("../../../src/policy")
  const { Location } = await import("../../../src/location")
  const { AppNodeBuilder } = await import("../../../src/effect/app-node-builder")
  const { LayerNode } = await import("../../../src/effect/layer-node")
  const { AbsolutePath } = await import("../../../src/schema")
  const { location } = await import("../../fixture/location")
  const layer = AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Global.node, Global.layerWith({ config: global })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workspace) }))),
    ],
  ])
  const runtime = ManagedRuntime.make(layer)
  try {
    const entries = await runtime.runPromise(Effect.flatMap(Config.Service, (service) => service.entries()))
    assert.equal(Config.latest(entries, "model"), "provider/project")
  } finally {
    await runtime.dispose()
  }
  if (mode === "v2-two") {
    const config = path.join(root, "second-config")
    const data = path.join(root, "second-data")
    const state = path.join(root, "second-state")
    await Promise.all([mkdir(config), mkdir(data), mkdir(state)])
    await writeFile(path.join(config, "kilo.json"), JSON.stringify({ ...schema, model: "provider/second" }))
    const layer = AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
      [Global.node, Global.layerWith({ config, data, state })],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(config) }))),
      ],
    ])
    const second = ManagedRuntime.make(layer)
    try {
      const entries = await second.runPromise(Effect.flatMap(Config.Service, (service) => service.entries()))
      assert.equal(Config.latest(entries, "model"), "provider/second")
    } finally {
      await second.dispose()
    }
  }
}

await verify(root, mode, cfg)
assert.equal(Global.Path.config, global)
await closeProcessProfile()
console.log("CONFIG_INTENT_PASS")
