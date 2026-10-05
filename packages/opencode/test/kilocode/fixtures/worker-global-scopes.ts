import { Global } from "@opencode-ai/core/global"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { observation } from "@/kilocode/cli/profile-retirement"
import * as tui from "@/kilocode/cli/cmd/tui/worker-identity"
import * as exporting from "@/kilocode/session-export/worker-identity"
import * as indexing from "@/kilocode/indexing-retirement"
import path from "node:path"
import z from "zod"
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { Config } from "@opencode-ai/core/config"
import { Policy } from "@opencode-ai/core/policy"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { location } from "../../../../core/test/fixture/location"

self.onmessage = async (event: MessageEvent<{ role: string; root: string; request: unknown; uncertain?: boolean }>) => {
  const data = event.data
  const global = Global.make({
    data: path.join(data.root, "data"),
    config: path.join(data.root, "config"),
    cache: path.join(data.root, "cache"),
    state: path.join(data.root, "state"),
    bin: path.join(data.root, "bin"),
    log: path.join(data.root, "log"),
    repos: path.join(data.root, "repos"),
    home: path.join(data.root, "home"),
  })
  await mkdir(global.config, { recursive: true })
  await writeFile(
    path.join(global.config, "kilo.json"),
    JSON.stringify({
      $schema: "https://app.kilo.ai/config.json",
      model: `provider/${data.role}`,
      ...(data.uncertain ? { unknown_field: true } : {}),
      provider: { synthetic: { options: { apiKey: "SYNTHETIC_CONFIG_SENTINEL" } } },
    }),
  )
  const runtime = ManagedRuntime.make(
    AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
      [Global.node, Global.layerWith(global)],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(data.root) }))),
      ],
    ]),
  )
  try {
    const entries = await runtime.runPromise(Effect.flatMap(Config.Service, (service) => service.entries()))
    assert.equal(Config.latest(entries, "model"), `provider/${data.role}`)
  } finally {
    await runtime.dispose()
  }
  await closeProcessProfile()
  const request = z
    .object({ runID: z.string().min(1), generation: z.string().uuid() })
    .passthrough()
    .parse(data.request)
  const reply =
    data.role === "worker"
      ? tui.acknowledge(
          tui.accept(
            request,
            tui.identity({
              KILO_RUN_ID: request.runID,
              KILO_WORKER_GENERATION: request.generation,
            }),
          ),
          observation(),
        )
      : data.role === "session-export-worker"
        ? exporting.acknowledge(exporting.accept(request, exporting.identity(request)), observation())
        : indexing.acknowledge(
            indexing.accept(request, {
              RAYA_INDEXING_RUN: request.runID,
              RAYA_INDEXING_GENERATION: request.generation,
            }),
          )
  self.postMessage(reply)
  self.onmessage = null
}
self.postMessage({ ready: true })
