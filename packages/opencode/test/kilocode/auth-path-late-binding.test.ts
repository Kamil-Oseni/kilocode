import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Auth } from "../../src/auth"
import { McpAuth } from "../../src/mcp/auth"

test("auth readers and writers resolve the active data root after module import", async () => {
  const reads: string[] = []
  const writes: string[] = []
  const fsLayer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        readJson: (file) =>
          Effect.sync(() => {
            reads.push(file)
            return {}
          }),
        writeJson: (file) => Effect.sync(() => writes.push(file)),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
  const layer = Layer.merge(
    AppNodeBuilder.build(Auth.node, [[FSUtil.node, fsLayer]]),
    AppNodeBuilder.build(McpAuth.node, [[FSUtil.node, fsLayer]]),
  )
  const original = Global.Path.data
  const active = path.join(original, "late-bound-test")

  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Global.Path.data = active
      }),
      () =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          const mcp = yield* McpAuth.Service
          yield* auth.set("example", { type: "api", key: "secret" })
          yield* mcp.set("example", { tokens: { accessToken: "token" } })
        }).pipe(Effect.provide(layer)),
      () =>
        Effect.sync(() => {
          Global.Path.data = original
        }),
    ),
  )

  expect(reads).toEqual([path.join(active, "auth.json"), path.join(active, "mcp-auth.json")])
  expect(writes).toEqual([path.join(active, "auth.json"), path.join(active, "mcp-auth.json")])
})
