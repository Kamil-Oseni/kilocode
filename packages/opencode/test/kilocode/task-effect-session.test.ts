import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Storage } from "@/storage/storage"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import * as Lineage from "@/kilocode/task/effect-lineage"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { TestInstance } from "../fixture/fixture"
import { database, storage } from "./fixtures/effect-profile"
import { testEffect } from "../lib/effect"

const flags = LayerNode.make({
  service: RuntimeFlags.Service,
  layer: RuntimeFlags.layer({ experimentalNativeLlm: true, experimentalEventSystem: true }),
  deps: [],
})
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionPrompt.node,
      SessionProjector.node,
      Database.node,
      Storage.node,
      Provider.node,
      Config.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
    ]),
    [
      [RuntimeFlags.node, flags],
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

// This is actual prompt/model/tool execution under original Routine execution
// lineage, without claiming SQL effect enrollment or inventing Routine metadata.
it.instance(
  "a genuine original execution survives SessionPrompt's queued bridge and native real Read tool callback",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fs = yield* FSUtil.Service
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const provider = yield* Provider.Service
      const cfg = yield* Config.Service
      const file = path.join(instance.directory, "owned-lineage.txt")
      const content = "Actual original file café 日本語 🚀"
      yield* fs.writeFileString(file, content)
      const posts: { model: string; phase: number }[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              expect(new URL(request.url).pathname).toBe("/api/chat")
              const body = await request.json()
              expect(body.model).toBe("owned-fixture")
              const phase = posts.length
              posts.push({ model: body.model, phase })
              expect(phase).toBeLessThan(2)
              if (phase === 0) {
                expect(body.tools.some((row: { function: { name: string } }) => row.function.name === "read")).toBe(
                  true,
                )
                return new Response(
                  [
                    {
                      model: body.model,
                      message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [{ function: { name: "read", arguments: { filePath: file } } }],
                      },
                      done: false,
                    },
                    { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 16, eval_count: 4 },
                  ]
                    .map((row) => JSON.stringify(row))
                    .join("\n") + "\n",
                )
              }
              expect(
                body.messages.some(
                  (row: { role: string; content: string }) => row.role === "tool" && row.content.includes(content),
                ),
              ).toBe(true)
              return new Response(
                [
                  {
                    model: body.model,
                    message: { role: "assistant", content: "Original execution completed" },
                    done: false,
                  },
                  { model: body.model, done: true, done_reason: "stop", prompt_eval_count: 20, eval_count: 4 },
                ]
                  .map((row) => JSON.stringify(row))
                  .join("\n") + "\n",
              )
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop()),
      )
      yield* cfg.update({
        snapshot: false,
        formatter: false,
        lsp: false,
        enabled_providers: ["openai"],
        model: "openai/owned-fixture",
        small_model: "openai/owned-fixture",
        provider: {
          openai: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: `${server.url}v1`,
              localInference: true,
              localInferenceAPI: "ollama",
              localInferenceContext: 32768,
            },
            models: {
              "owned-fixture": { name: "Owned fixture", tool_call: true, limit: { context: 32768, output: 1024 } },
            },
          },
        },
      })
      const model = yield* provider.getModel(ProviderV2.ID.make("openai"), ModelV2.ID.make("owned-fixture"))
      expect(
        LLMNativeRuntime.status({ model, provider: yield* provider.getProvider(model.providerID), auth: undefined })
          .type,
      ).toBe("supported")
      const session = yield* sessions.create({ title: "Original execution lineage" })
      const owner = { id: crypto.randomUUID(), agentID: crypto.randomUUID(), sessionID: session.id }
      const execution = RayaTaskExecution.make(storage)
      const database = yield* Database.Service
      const selected = yield* database.db.all<{ name: string; file: string }>("PRAGMA database_list")
      expect(selected.find((row) => row.name === "main")?.file).toEndWith("authority.sqlite")
      const acquired = yield* execution.acquire(owner).pipe(Effect.exit)
      if (Exit.isFailure(acquired)) return yield* acquired
      expect(acquired.value).toBeDefined()
      const result = yield* execution.enter(
        owner,
        Effect.gen(function* () {
          expect(yield* Lineage.bind()).toBeDefined()
          return yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: model.providerID, modelID: model.id },
            parts: [{ type: "text", text: `Read ${file}, then confirm completion.` }],
          })
        }),
      )
      if (!result) throw new Error("Original prompt did not execute")
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("Original prompt result is not assistant")
      expect(result.info.error).toBeUndefined()
      expect(
        result.parts
          .filter((row) => row.type === "text")
          .map((row) => row.text)
          .join(""),
      ).toBe("Original execution completed")
      const rows = yield* sessions.messages({ sessionID: session.id })
      const tools = rows.flatMap((row) => row.parts).filter((row) => row.type === "tool")
      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({ tool: "read", state: { status: "completed", input: { filePath: file } } })
      expect(JSON.stringify(tools[0])).toContain(content)
      expect(posts).toEqual([
        { model: "owned-fixture", phase: 0 },
        { model: "owned-fixture", phase: 1 },
      ])
      yield* execution.finish(owner)
      expect(yield* execution.receipt(owner)).toBeUndefined()
    }),
  { config: { snapshot: false, plugin: [], mcp: {} } },
  60_000,
)
