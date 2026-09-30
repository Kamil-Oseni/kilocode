import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "../../../src/provider/provider"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, CrossSpawnSpawner.node])))
const entry = { name: "Fixture", limit: { context: 8192, output: 1024 } }
const local = ProviderV2.ID.make("local")
const main = ModelV2.ID.make("main-9b")
const config = (enabled?: boolean) => ({
  formatter: false as const,
  lsp: false as const,
  model: "local/main-9b",
  small_model: "other/small",
  enabled_providers: ["local", "other"],
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:1/v1", ...(enabled === undefined ? {} : { localInference: enabled }) },
      models: { "main-9b": entry },
    },
    other: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:2/v1" },
      models: { small: entry },
    },
  },
})

afterEach(disposeAllInstances)

it.instance(
  "explicit local helpers retain the exact selected model despite a global cloud small model",
  () =>
    Provider.Service.use((svc) =>
      Effect.gen(function* () {
        const small = yield* svc.getSmallModel(local)
        expect(small).toBeUndefined()
        const model = small ?? (yield* svc.getModel(local, main))
        expect(model.providerID).toBe(local)
        expect(model.id).toBe(main)
        const missing = yield* svc.getModel(local, ModelV2.ID.make("missing")).pipe(Effect.result)
        expect(missing._tag).toBe("Failure")
      }),
    ),
  { config: config(true) },
  30_000,
)

for (const enabled of [undefined, false]) {
  it.instance(
    `ordinary helper configuration remains unchanged when localInference is ${String(enabled)}`,
    () =>
      Provider.Service.use((svc) =>
        svc.getSmallModel(local).pipe(
          Effect.map((model) => {
            expect(model?.providerID).toBe(ProviderV2.ID.make("other"))
            expect(model?.id).toBe(ModelV2.ID.make("small"))
          }),
        ),
      ),
    { config: config(enabled) },
    30_000,
  )
}

for (const enabled of [true, false]) {
  it.instance(
    `real plugin helper overrides ${enabled ? "cannot replace" : "remain available for"} a selected provider`,
    () =>
      Provider.Service.use((svc) =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const model = yield* svc.getSmallModel(local)
          expect(model?.providerID).toBe(enabled ? undefined : ProviderV2.ID.make("other"))
          expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "called.txt")).exists())).toBe(
            !enabled,
          )
          if (enabled) expect((yield* svc.getModel(local, main)).id).toBe(main)
        }),
      ),
    {
      init: (dir) =>
        Effect.gen(function* () {
          const file = path.join(dir, "helper.ts")
          yield* Effect.promise(() =>
            Bun.write(
              file,
              `export default async () => ({
          "experimental.provider.small_model": async (_input, output) => {
            await Bun.write(${JSON.stringify(path.join(dir, "called.txt"))}, "called")
            output.model = { id: "small", providerID: "other" }
          }
        })`,
            ),
          )
          const cfg = config(enabled)
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, "opencode.json"),
              JSON.stringify({
                ...cfg,
                small_model: undefined,
                plugin: [pathToFileURL(file).href],
              }),
            ),
          )
        }),
    },
    30_000,
  )
}
