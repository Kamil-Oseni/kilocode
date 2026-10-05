import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Auth } from "../../src/auth"
import { McpAuth } from "../../src/mcp/auth"

test("auth readers and writers resolve the active temporary data root after module import", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-auth-late-"))
  const active = path.join(dir, "selected")
  const original = Global.Path.data
  const layer = Layer.merge(AppNodeBuilder.build(Auth.node), AppNodeBuilder.build(McpAuth.node))
  try {
    Global.Path.data = active
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const mcp = yield* McpAuth.Service
        yield* auth.set("example", { type: "api", key: "synthetic" })
        yield* mcp.set("example", { tokens: { accessToken: "synthetic" } })
        expect(yield* auth.get("example")).toEqual({ type: "api", key: "synthetic" })
        expect(yield* mcp.get("example")).toMatchObject({ tokens: { accessToken: "synthetic" } })
      }).pipe(Effect.provide(layer)),
    )
    expect(await Bun.file(path.join(active, "auth.json")).json()).toEqual({
      example: { type: "api", key: "synthetic" },
    })
    expect(await Bun.file(path.join(active, "mcp-auth.json")).json()).toMatchObject({
      example: { tokens: { accessToken: "synthetic" } },
    })
    expect(await Bun.file(path.join(dir, "auth.json")).exists()).toBe(false)
  } finally {
    Global.Path.data = original
    await rm(dir, { recursive: true, force: true })
  }
})
