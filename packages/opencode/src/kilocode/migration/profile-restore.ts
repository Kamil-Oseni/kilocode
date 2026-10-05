import { createHash } from "node:crypto"
import { mkdir, open, realpath, rename, stat } from "node:fs/promises"
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { checkpoints, tables, unseal, payload } from "./profile-bundle"
import { Hash } from "@opencode-ai/core/util/hash"
import { identity, remap } from "./profile-workspaces"
import { attach, materialize } from "./profile-artifacts"
import { ordinary } from "./profile-tui"
import { contents, remapComposers } from "./profile-composers"
import { restoreNotes } from "./profile-notes"
import { restoreStores } from "./profile-stores"
import { restoreOutputs } from "./profile-outputs"
import { restoreSelfHeal } from "./profile-self-heal"
import { allocatorLedger } from "./profile-sql-metadata"
import { renderReview } from "./profile-restore-review-schema"

export type Column = { name: string; type: string; notnull: number; pk: number }

/** Bind portable row data to the destination's shipped schema, never source-supplied DDL. */
export function signature(read: (query: string) => Effect.Effect<readonly Column[], unknown>) {
  return Effect.gen(function* () {
    const values = yield* Effect.forEach(tables, (table) =>
      read(`PRAGMA table_info('${table}')`).pipe(
        Effect.map((columns) => ({
          table,
          columns: columns.map((column) => ({
            name: column.name,
            type: column.type,
            notnull: column.notnull,
            pk: column.pk,
          })),
        })),
      ),
    )
    return createHash("sha256").update(JSON.stringify(values)).digest("hex")
  })
}

async function durable(file: string, value: unknown) {
  return bytes(file, JSON.stringify(value))
}

async function bytes(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, "wx", 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Restore into a newly reserved, inactive container. Publication follows closed SQLite and durable hold. */
export async function restore(
  text: string,
  password: string,
  target: string,
  mappings: Readonly<Record<string, string>>,
  options: { primaries?: readonly string[] } = {},
) {
  const original = await unseal(text, password)
  if (!path.isAbsolute(target)) throw new Error("Destination must be an absolute new profile container")
  if (
    Object.keys(mappings).length !== original.workspaces.length ||
    original.workspaces.some((item) => !(item in mappings))
  )
    throw new Error("Map every source workspace explicitly before restoring")
  const mapping = new Map<string, string>()
  for (const source of original.workspaces) {
    identity(source)
    const destination = mappings[source]
    if (!path.isAbsolute(destination)) throw new Error("Destination workspace mapping must be absolute")
    const managed = original.artifacts?.worktrees.find((item) => identity(item.workspace) === identity(source))
    if (managed) {
      const reserved = path.join(target, "data", "kilo", "worktree", managed.project, managed.name)
      if (path.resolve(destination) !== reserved)
        throw new Error("Managed worktree mapping must use the inactive container")
      mapping.set(source, reserved)
      continue
    }
    const canonical = await realpath(destination)
    if (!(await stat(canonical)).isDirectory()) throw new Error("Destination workspace mapping is not a directory")
    mapping.set(source, canonical)
  }
  const { inactive } = await import("./profile-safety")
  const prepared = inactive(original, Date.now(), mapping)
  const content = original.composers ?? contents(original.sql)
  const composers = content ? remapComposers(content, mapping) : undefined
  const value = { ...prepared, sql: remap(prepared.sql, mapping) }
  const { MemoryPaths } = await import("@kilocode/kilo-memory/paths")
  const destinations = new Map([...mapping].map(([source, destination]) => [identity(source), destination]))
  const memories = value.memory.map((item) => {
    const directory = destinations.get(identity(item.workspace))
    if (!directory) throw new Error("Standalone memory workspace lacks a canonical destination mapping")
    return { item, identity: MemoryPaths.identity({ ctx: { directory, worktree: directory } }) }
  })
  if (new Set(memories.map((item) => item.identity.folder.toLowerCase())).size !== memories.length)
    throw new Error("Standalone memory workspace mappings collide")
  // Exclusive mkdir is the no-overwrite reservation. The profile is never visible at its
  // final path until the staged native database has closed and all hold metadata is durable.
  await mkdir(target)
  await mkdir(path.join(target, "data"))
  const stage = path.join(target, ".pending")
  await mkdir(stage)
  const storesAt = Date.now()
  const stores = await restoreStores(original, mapping, storesAt, stage, path.join(target, "data", "kilo"))
  const storage = path.join(stage, "storage")
  const hold = { version: 1, id: crypto.randomUUID(), state: "held", createdAt: Date.now() }
  await durable(path.join(storage, "raya", "restore-hold.json"), hold)
  await durable(
    path.join(stage, "restore-review.json"),
    renderReview({ bundle: value.id, hold: hold.id, mapping, storesAt, primaries: options.primaries ?? [] }),
  )
  await durable(path.join(stage, "restore-source.json"), original)
  await durable(path.join(stage, "restore-preferences.json"), value.preferences)
  if (original.config) await durable(path.join(stage, "restore-config.json"), original.config)
  if (original.disposition) await durable(path.join(stage, "restore-disposition.json"), original.disposition)
  if (original.secondary) await durable(path.join(stage, "restore-secondary.json"), original.secondary)
  if (stores)
    await durable(path.join(stage, "restore-stores.json"), {
      format: "raya.inactive-profile-stores",
      version: 1,
      activation: "held",
      stores,
    })
  if (value.host) await durable(path.join(stage, "restore-host.json"), value.host)
  if (value.selfHeal) await restoreSelfHeal(value.selfHeal, stage)
  if (value.tui) await durable(path.join(stage, "restore-tui.json"), value.tui)
  if (value.exports) await durable(path.join(stage, "restore-exports.json"), value.exports)
  if (original.voice) await durable(path.join(stage, "restore-voice-reconciliation.json"), original.voice)
  if (original.operational) await durable(path.join(stage, "restore-operational.json"), original.operational)
  const ledger = allocatorLedger(original.disposition)
  if (ledger) await durable(path.join(stage, "restore-sql-metadata.json"), ledger)
  if (original.outputs)
    value.sql = payload.shape.sql.parse(
      await restoreOutputs(original.outputs, stage, path.join(target, "data", "kilo"), value.sql),
    )
  const { Database } = await import("@opencode-ai/core/database/database")
  const runtime = ManagedRuntime.make(Database.layerFromPath(path.join(stage, "raya.db")))
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* Database.Service
      const db = service.db
      if ((yield* signature((query) => db.all<Column>(query))) !== value.schema)
        throw new Error("Portable data schema does not match this installed release")
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.run("PRAGMA defer_foreign_keys = ON")
          for (const table of value.sql) {
            // Source control, cursors and root proofs remain in restore-source.json only.
            // Genuine v1 content below lets normal startup create fresh destination ownership.
            if (table.table === "raya_composer_control" || table.table === "raya_composer_draft") continue
            const columns = yield* tx.all<Column>(`PRAGMA table_info('${table.table}')`)
            if (
              columns.length !== table.columns.length ||
              columns.some((column, index) => column.name !== table.columns[index])
            )
              throw new Error("Portable SQL columns do not match the shipped table")
            for (const row of table.rows) {
              for (const [index, item] of row.entries()) {
                const column = columns[index]
                if (item === null) {
                  if (column.notnull || column.pk)
                    throw new Error("Portable SQL null violates the shipped column contract")
                  continue
                }
                const type = column.type.toLowerCase()
                if (
                  (type === "text" && typeof item !== "string") ||
                  (type === "integer" && (typeof item !== "number" || !Number.isSafeInteger(item))) ||
                  (type === "real" && typeof item !== "number")
                )
                  throw new Error("Portable SQL scalar violates the shipped column type")
              }
              const data = row.map((item, index) => {
                const column = table.columns[index]
                if (table.table === "session" && (column === "permission" || column === "share_url")) return null
                return item
              })
              yield* tx.run(
                sql`INSERT INTO ${sql.identifier(table.table)} (${sql.join(
                  table.columns.map((column) => sql.identifier(column)),
                  sql`, `,
                )}) VALUES (${sql.join(
                  data.map((item) => sql`${item}`),
                  sql`, `,
                )})`,
              )
            }
          }
          const failures = yield* tx.all<Record<string, unknown>>("PRAGMA foreign_key_check")
          if (failures.length) throw new Error("Portable SQL relationships failed validation")
        }),
      )
    }).pipe(Effect.exit),
  )
  const failures: unknown[] = []
  if (result._tag === "Failure") failures.push(result.cause)
  try {
    await runtime.dispose()
  } catch (err) {
    failures.push(err)
  }
  if (failures.length)
    throw new AggregateError(failures, `Restore refused; inactive diagnostic staging retained at ${stage}`)
  for (const item of value.json) {
    if (item.path === "raya/composer-drafts.json" || item.path === "raya/composer-drafts-initialized.json") continue
    await durable(path.join(storage, ...item.path.split("/")), JSON.parse(item.value))
  }
  if (composers) {
    await durable(path.join(storage, "raya", "composer-drafts.json"), composers)
    await durable(path.join(storage, "raya", "composer-drafts-initialized.json"), {
      version: 1,
      format: "raya.restored-composer-content",
      id: crypto.randomUUID(),
      pendingProject: "destination",
    })
  }
  if (memories.length) {
    const { Memory } = await import("@kilocode/kilo-memory/memory")
    const { MemoryFiles } = await import("@kilocode/kilo-memory/store")
    const { MemorySchema } = await import("@kilocode/kilo-memory/schema")
    for (const selected of memories) {
      const root = path.join(stage, "memory", selected.identity.folder)
      const item = selected.item
      await durable(path.join(root, "restore.json"), { format: "raya.restored-memory", version: 1, hold: hold.id })
      await durable(path.join(root, "restore-evidence.json"), {
        workspace: item.workspace,
        state: JSON.parse(item.state),
        decisions: item.decisions,
        ...(item.lineage ? { lineage: item.lineage } : {}),
      })
      if (item.quarantine) {
        const { renderQuarantine } = await import("./profile-memory-quarantine-history")
        await durable(
          path.join(root, "restore-quarantine.json"),
          renderQuarantine(item.quarantine, item.quarantineLineage),
        )
      }
      for (const [name, text] of Object.entries(item.sources)) await bytes(path.join(root, name), text)
      await bytes(path.join(root, ".gitignore"), "*\n!.gitignore\n")
      await mkdir(path.join(root, "sessions"))
      for (const session of item.sessions) await bytes(path.join(root, "sessions", session.name), session.text)
      const state = MemorySchema.parse(JSON.parse(item.state))
      await MemoryFiles.writeState(root, {
        ...state,
        enabled: false,
        autoConsolidate: false,
        capture: { ...state.capture, turnClose: false, explicit: false },
        stats: MemorySchema.create().stats,
      })
      await MemoryFiles.writeManifest(root, selected.identity)
      await Memory.rebuild({ root })
    }
  }
  const destination = path.join(target, "data", "kilo")
  if (options.primaries?.length && !value.artifacts)
    throw new Error("Primary Git attachment requires captured artifacts")
  if (value.artifacts) await materialize(value.artifacts, stage, destination, mapping, options.primaries)
  if (value.notes) await restoreNotes(value.notes, stage, destination, mapping, original.sql)
  // Named checkpoints must resolve to actual tree objects before publishing the inactive profile.
  // The source snapshot metadata is bound by the bundle schema; Git reads only the rebuilt inert store.
  for (const item of original.json.filter((item) => item.path.startsWith("raya/checkpoint/"))) {
    const rows = checkpoints.parse(JSON.parse(item.value))
    if (rows.length === 0) continue
    const sessions = original.sql.find((item) => item.table === "session")
    const session = sessions?.rows.find((row) => row[sessions.columns.indexOf("id")] === item.path.slice(16, -5))
    const workspace = sessions && session?.[sessions.columns.indexOf("directory")]
    const project = sessions && session?.[sessions.columns.indexOf("project_id")]
    const snapshot = original.artifacts?.snapshots
      .filter(
        (item) =>
          item.project === project &&
          typeof workspace === "string" &&
          (identity(workspace) === identity(item.workspace) ||
            identity(workspace).startsWith(identity(item.workspace) + "/")),
      )
      .sort((left, right) => right.workspace.length - left.workspace.length)[0]
    const mapped = snapshot ? destinations.get(identity(snapshot.workspace)) : undefined
    if (!mapped || typeof project !== "string") throw new Error("Checkpoint snapshot mapping is unavailable")
    const directory = path.join(stage, "snapshot", project, Hash.fast(mapped))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(stage, ".absent-git-config"),
      GIT_TERMINAL_PROMPT: "0",
    })
    for (const row of rows) {
      const child = Bun.spawn(
        [
          "git",
          "-c",
          "core.fsmonitor=false",
          ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
          "--git-dir",
          path.relative(stage, directory),
          "cat-file",
          "-e",
          `${row.hash}^{tree}`,
        ],
        { env, cwd: stage, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
      )
      const timer = setTimeout(() => child.kill(), 10_000)
      const code = await child.exited
      clearTimeout(timer)
      if (code !== 0) throw new Error("Imported checkpoint tree is unavailable")
    }
  }
  if (value.tui) await durable(path.join(target, "state", "kilo", "kv.json"), ordinary(value.tui))
  await rename(stage, destination)
  if (value.artifacts && options.primaries?.length)
    await attach(value.artifacts, destination, mapping, options.primaries)
  return Object.freeze({
    format: "raya.restored-profile" as const,
    version: 1 as const,
    path: destination,
    hold: hold.id,
    reviewed: false as const,
    reconnectCredentials: true as const,
    uncertainWork: "held-no-replay" as const,
    env: Object.freeze({
      HOME: path.join(target, "home"),
      USERPROFILE: path.join(target, "home"),
      LOCALAPPDATA: path.join(target, "local"),
      KILO_TEST_HOME: path.join(target, "home"),
      XDG_DATA_HOME: path.join(target, "data"),
      XDG_CONFIG_HOME: path.join(target, "config"),
      XDG_STATE_HOME: path.join(target, "state"),
      XDG_CACHE_HOME: path.join(target, "cache"),
      RAYA_DB: path.join(destination, "raya.db"),
      KILO_DB: path.join(destination, "raya.db"),
    }),
  })
}
