export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { DbPreflight } from "../kilocode/db-preflight" // kilocode_change
import { ensure as compat } from "../kilocode/database-compat" // kilocode_change
import { resolve } from "../kilocode/database-path" // kilocode_change
import { EnvAlias } from "../kilocode/env-alias" // kilocode_change
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    // kilocode_change start - install SQLite's busy handler before concurrent processes can race to recover the WAL
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA journal_mode = WAL")
    // kilocode_change end
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)
    yield* compat(db) // kilocode_change - keep the shared database usable by released CLIs

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  DbPreflight.assertWritable(filename) // kilocode_change - actionable error (and self-heal for kilo-owned files) instead of an opaque wal_checkpoint crash on read-only db files
  return layer.pipe(Layer.provide(sqliteLayer({ filename, disableWAL: true }))) // kilocode_change - Database configures WAL after busy_timeout
}

export function path() {
  // kilocode_change start - both database clients use one late-bound legacy path resolver before any profile cutover
  return resolve({
    data: Global.Path.data,
    channel: InstallationChannel,
    disabled: EnvAlias.enabled("RAYA_DISABLE_CHANNEL_DB", "KILO_DISABLE_CHANNEL_DB"),
    override: Flag.KILO_DB,
  })
  // kilocode_change end
}

// kilocode_change - resolve the database path when the layer builds, not at module evaluation, so KILO_DB overrides set after import (tests, embedded hosts) take effect
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.unwrap(Effect.sync(() => layerFromPath(path()))),
  deps: [],
})
