import { describe, expect } from "bun:test"
import path from "path"
import { ConfigProvider, Effect, Layer } from "effect" // kilocode_change
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder" // kilocode_change
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { it } from "../lib/effect"

// kilocode_change start
const fromConfig = (input: Record<string, unknown>) =>
  AppNodeBuilder.build(RuntimeFlags.node).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))
// kilocode_change end

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "kilo.db")
        : path.join(Global.Path.data, `kilo-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`) // kilocode_change

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared database path when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "kilo.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )

  // kilocode_change start
  it.effect("uses the Raya channel-database alias through RuntimeFlags", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.disableChannelDb).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "kilo.db"))
    }).pipe(Effect.provide(fromConfig({ RAYA_DISABLE_CHANNEL_DB: "true", KILO_DISABLE_CHANNEL_DB: "false" }))),
  )

  it.effect("uses the Raya migration-skip alias through RuntimeFlags", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
    }).pipe(Effect.provide(fromConfig({ RAYA_SKIP_MIGRATIONS: "true", KILO_SKIP_MIGRATIONS: "false" }))),
  )
  // kilocode_change end
})
