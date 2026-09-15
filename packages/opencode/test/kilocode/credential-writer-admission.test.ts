import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "node:path"
import { Auth } from "@/auth"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"
import { ProfileWriterRegistry } from "@/kilocode/migration/writer-registry"
import { McpAuth } from "@/mcp/auth"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, EffectFlock.node, CrossSpawnSpawner.node])))
const ids = ["profile.credentials.auth", "profile.credentials.mcp"] as const

function observed(registry: ProfileWriterRegistry.Registry, id: (typeof ids)[number], seen: string[]) {
  const base = ProfileWriterLive.from(registry, id)
  return {
    run: <A, E, R>(body: Effect.Effect<A, E, R>) =>
      base.run(
        registry.snapshot.pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              const active = snapshot.active.find((item) => item.id === id)
              expect(active?.count).toBe(1)
              seen.push(id)
            }),
          ),
          Effect.andThen(body),
        ),
      ),
  }
}

describe("credential writer admission", () => {
  it.live("selects each profile path only after writer admission", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const outside = path.join(root, "outside")
      const authRoot = path.join(root, "auth")
      const mcpRoot = path.join(root, "mcp")
      const fs = yield* FSUtil.Service
      yield* Effect.forEach([outside, authRoot, mcpRoot], (dir) => fs.makeDirectory(dir), { discard: true })
      const registry = ProfileWriterRegistry.make(ids)
      yield* Effect.forEach(ids, (id) => registry.register(id), { discard: true })
      const switcher = (id: (typeof ids)[number], dir: string): ProfileWriterLive.Admission => {
        const base = ProfileWriterLive.from(registry, id)
        return {
          run: (body) =>
            base.run(
              Effect.sync(() => {
                Global.Path.data = dir
              }).pipe(Effect.andThen(body)),
            ),
        }
      }
      const layer = Layer.merge(
        Auth.layerWithAdmission(switcher(ids[0], authRoot)),
        McpAuth.layerWithAdmission(switcher(ids[1], mcpRoot)),
      )
      const original = Global.Path.data

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Global.Path.data = outside
        }),
        () =>
          Effect.gen(function* () {
            const credentials = yield* Auth.Service
            const oauth = yield* McpAuth.Service
            yield* credentials.set("provider", { type: "api", key: "secret" })
            Global.Path.data = outside
            yield* oauth.set("server", { tokens: { accessToken: "token" } })

            expect(yield* Effect.promise(() => Bun.file(path.join(authRoot, "auth.json")).exists())).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(path.join(mcpRoot, "mcp-auth.json")).exists())).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(path.join(outside, "auth.json")).exists())).toBe(false)
            expect(yield* Effect.promise(() => Bun.file(path.join(outside, "mcp-auth.json")).exists())).toBe(false)
          }).pipe(Effect.provide(layer)),
        () =>
          Effect.sync(() => {
            Global.Path.data = original
          }),
      )
    }),
  )

  it.live("covers every credential mutation and refuses writes while closed", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const data = path.join(root, "data")
      const fs = yield* FSUtil.Service
      yield* fs.makeDirectory(data, { recursive: true })
      const registry = ProfileWriterRegistry.make(ids)
      yield* Effect.forEach(ids, (id) => registry.register(id), { discard: true })
      const seen: string[] = []
      const auth = observed(registry, ids[0], seen)
      const mcp = observed(registry, ids[1], seen)
      const layer = Layer.merge(Auth.layerWithAdmission(auth), McpAuth.layerWithAdmission(mcp))
      const original = Global.Path.data

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Global.Path.data = data
        }),
        () =>
          Effect.gen(function* () {
            const credentials = yield* Auth.Service
            const oauth = yield* McpAuth.Service

            yield* credentials.set("provider/", { type: "api", key: "secret" })
            yield* credentials.remove("provider")
            yield* oauth.set("server", {}, "https://example.com/mcp")
            yield* oauth.updateTokens("server", { accessToken: "token" })
            yield* oauth.updateClientInfo("server", { clientId: "client" })
            yield* oauth.updateCodeVerifier("server", "verifier")
            yield* oauth.clearCodeVerifier("server")
            yield* oauth.updateOAuthState("server", "state")
            yield* oauth.clearOAuthState("server")
            yield* oauth.remove("server")

            expect(seen.filter((id) => id === ids[0])).toHaveLength(2)
            expect(seen.filter((id) => id === ids[1])).toHaveLength(8)
            expect(yield* credentials.all()).toEqual({})
            expect(yield* oauth.all()).toEqual({})
            expect(seen).toHaveLength(10)

            const beforeAuth = yield* Effect.promise(() => Bun.file(path.join(data, "auth.json")).text())
            const beforeMcp = yield* Effect.promise(() => Bun.file(path.join(data, "mcp-auth.json")).text())
            const entered = yield* Deferred.make<void>()
            const owner = yield* registry
              .quiesce(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
              .pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(entered)

            expect(
              Exit.isFailure(yield* credentials.set("blocked", { type: "api", key: "no" }).pipe(Effect.exit)),
            ).toBe(true)
            expect(Exit.isFailure(yield* oauth.set("blocked", {}).pipe(Effect.exit))).toBe(true)
            expect(yield* Effect.promise(() => Bun.file(path.join(data, "auth.json")).text())).toBe(beforeAuth)
            expect(yield* Effect.promise(() => Bun.file(path.join(data, "mcp-auth.json")).text())).toBe(beforeMcp)

            yield* Fiber.interrupt(owner)
            yield* credentials.set("resumed", { type: "api", key: "yes" })
            yield* oauth.set("resumed", { tokens: { accessToken: "yes" } })
            expect((yield* credentials.get("resumed"))?.type).toBe("api")
            expect((yield* oauth.get("resumed"))?.tokens?.accessToken).toBe("yes")
            expect(yield* registry.snapshot).toMatchObject({ phase: "open", active: [] })
          }).pipe(Effect.provide(layer)),
        () =>
          Effect.sync(() => {
            Global.Path.data = original
          }),
      )
    }),
  )
})
