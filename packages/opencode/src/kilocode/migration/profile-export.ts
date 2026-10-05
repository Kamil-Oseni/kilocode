import { Database } from "bun:sqlite"
import { lstat, opendir, realpath } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { assertCapture } from "./capture-authority"
import { filename, payload, seal, tables } from "./profile-bundle"
import { signature, type Column } from "./profile-restore"
import { memories } from "./profile-memory"
import { historical } from "./profile-evidence"
import { selected, type Files } from "./profile-preference-files"
import { identity, references } from "./profile-workspaces"
import { evidence } from "./profile-exports"
import { database as validateDatabase, read } from "./profile-file"
import { measure } from "./profile-sql"
import { locate } from "./profile-data"
import { collect } from "./profile-artifacts"
import type { Working } from "./profile-image"
import type { Payload, VerifiedCapsule } from "@opencode-ai/core/kilocode/source-capsule"
import { held } from "./profile-host"
import { collectTui } from "./profile-tui"
import { collectComposers } from "./profile-composers"
import { collectNotes } from "./profile-notes"
import { collectStores, stores as validateStores } from "./profile-stores"
import { collectStoreContent } from "./profile-store-content"
import { assertWorking } from "./profile-image"
import { collectOutputs } from "./profile-outputs"
import { collectSelfHeal } from "./profile-self-heal"
import type { ConfigEvidence } from "./profile-config"
import type z from "zod"
import { boundData, collectSecondary } from "./profile-secondary"
import { bindDisposition, collectDisposition } from "./profile-disposition"
import { bindGit } from "./profile-git-correspondence"
import { bindHost } from "./profile-host-correspondence"
import { bindConfig } from "./profile-config-correspondence"
import { bindMarkdown } from "./profile-config-markdown-correspondence"
import { PlanArtifact } from "../plan-artifact"
import { bindSQL } from "./profile-sql-correspondence"
import { readMemory, memoryValues, bindMemory } from "./profile-memory-correspondence"
import { bindStorage } from "./profile-storage-correspondence"
import { bindGitMetadata } from "./profile-git-metadata-correspondence"
import { readVoice, voiceValues, bindVoice } from "./profile-voice-reconciliation"
import { bindHostModel } from "./profile-host-model-correspondence"
import { bindComposer } from "./profile-composer-correspondence"
import { bindMemoryDerived } from "./profile-memory-derived"
import { readOperational, operationalValues, bindOperational } from "./profile-operational-correspondence"
import { readHistorical } from "./profile-restored-evidence"
import { bindRestoredGit, restoredGitValues } from "./profile-restored-git-correspondence"
import { bindRestoredComponents, restoredComponentValues } from "./profile-restored-components-correspondence"
import { bindTui } from "./profile-tui-correspondence"
import { bindRestoredSources, restoredSourceValues } from "./profile-restored-source-correspondence"
import { bindHold } from "./profile-restore-hold-correspondence"

type Root = Readonly<{ kind: "sqlite" | "json"; path: string }>
const key = (root: Root) => `${root.kind}:${process.platform === "win32" ? root.path.toLowerCase() : root.path}`

/** Called only within the complete controller's held-gate callback. No serialized proof is authority. */
export async function exportProfile(
  proof: unknown,
  roots: readonly Root[],
  source: { database: string; storage: string; data?: string; preferences?: Files; exports?: string },
  password: string,
  artifacts?: {
    working: Working
    data: string
    host?: Payload
    hostProof?: VerifiedCapsule
    states?: readonly string[]
    globals?: readonly { data: string }[]
    selfHealScopes?: readonly { data: string; storage: string }[]
    workspaces?: readonly string[]
    config?: z.output<typeof ConfigEvidence>
  },
) {
  assertCapture(proof, roots)
  const database = await validateDatabase(source.database)
  const storage = await realpath(source.storage)
  const located = await locate(storage, source.data)
  const required: Root[] = [
    { kind: "sqlite", path: database },
    { kind: "json", path: storage },
  ]
  if (required.some((root) => !roots.some((selected) => key(selected) === key(root))))
    throw new Error("Capture authority does not include the selected database and storage")
  assertCapture(proof, roots)
  // This is the controller's maintenance reader: ordinary native admission is fenced
  // by the held gates, so it opens only after capability validation and closes before returning.
  const stores = artifacts
    ? await (async () => {
        const image = assertWorking(artifacts.working)
        const primary = image.stores.find((store) => store.staged === image.profile.database)?.original
        const auxiliary = image.profile.exports
          ? image.stores.find((store) => store.staged === image.profile.exports)?.original
          : undefined
        if (!primary) throw new Error("Primary database lacks recovered original binding")
        const stores = await collectStores(artifacts.working, primary, auxiliary)
        return validateStores.parse(await collectStoreContent(artifacts.working, stores, primary))
      })()
    : undefined
  const db = new Database(database, { readonly: true, strict: true })
  const collected = (() => {
    try {
      const schema = Effect.runSync(signature((query) => Effect.sync(() => db.query<Column, []>(query).all())))
      const metadata = tables.map((table) => ({
        table,
        columns: db.query<Column, []>(`PRAGMA table_info('${table}')`).all(),
      }))
      const bytes = metadata.reduce(
        (sum, item) =>
          sum +
          measure(
            db,
            item.table,
            item.columns.map((column) => column.name),
          ),
        0,
      )
      if (bytes > 128 * 1024 * 1024) throw new Error("Portable SQL exceeds the supported bundle size")
      const sql = tables.map((table) => {
        const columns = db.query<Column, []>(`PRAGMA table_info('${table}')`).all()
        return {
          table,
          columns: columns.map((column) => column.name),
          rows: db
            .query(`SELECT * FROM "${table}"`)
            .values()
            .map((row) =>
              row.map((value, index) =>
                table === "session" && ["permission", "share_url"].includes(columns[index].name) ? null : value,
              ),
            ),
        }
      })
      const checked = payload.shape.sql.parse(sql)
      return { schema, sql: checked, workspaces: references(checked).sort() }
    } finally {
      db.close()
    }
  })()
  const json: { path: string; value: string }[] = []
  let bytes = 0
  let count = 0
  async function visit(dir: string, depth = 0) {
    if (depth > 64) throw new Error("Portable storage exceeds its supported depth")
    for await (const item of await opendir(dir)) {
      if (++count > 100_000) throw new Error("Portable storage exceeds its supported entry count")
      if (item.isSymbolicLink()) throw new Error("Portable storage contains an unverified symbolic link")
      const file = path.join(dir, item.name)
      if (item.isDirectory()) {
        await visit(file, depth + 1)
        continue
      }
      if (!item.isFile() || !item.name.endsWith(".json")) continue
      const relative = path.relative(storage, file).split(path.sep).join("/")
      if (relative === "raya/restore-hold.json") continue
      // Validate each selected path; exclude unrelated caches/configuration instead of
      // silently broadening the allowlist to include credentials or machine authority.
      if (!filename.safeParse(relative).success) continue
      const selected = await read(file, 128 * 1024 * 1024 - bytes)
      bytes += selected.bytes
      json.push(payload.shape.json.element.parse({ path: relative, value: selected.value }))
    }
  }
  await visit(storage)
  json.sort((a, b) => a.path.localeCompare(b.path))
  const composers = await collectComposers(collected.sql, storage)
  if (!roots.some((root) => key(root) === key({ kind: "json", path: located.data })))
    throw new Error("Capture authority omits standalone memory data root")
  if (artifacts) await boundData(artifacts.working, located.data)
  const reader = artifacts ? await readMemory(artifacts.working, artifacts.data) : undefined
  const memory = artifacts && reader ? memoryValues(artifacts.working, reader) : await memories(located.memory)
  const history = await historical(located.data)
  const preferences = await selected(source.preferences, roots)
  const file = source.exports ?? located.exports
  const stat = await lstat(file).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  const exports = await (async () => {
    if (!stat) return undefined
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Unverified session export database")
    const canonical = await realpath(file)
    if (!roots.some((root) => key(root) === key({ kind: "sqlite", path: canonical })))
      throw new Error("Capture authority omits session export database")
    assertCapture(proof, roots)
    return evidence(canonical)
  })()
  const workspaces = [
    ...new Map(
      [
        ...memory.map((item) => item.workspace),
        ...collected.workspaces,
        ...(artifacts?.workspaces ?? []),
        ...(stores?.flatMap((store) => (store.kind === "raya" ? store.workspaces : [])) ?? []),
        ...(composers?.entries.map((item) => item.identity.workspace) ?? []),
      ].map((file) => [identity(file), file]),
    ).values(),
  ].sort()
  const git = artifacts ? await collect(artifacts.working, { data: artifacts.data, workspaces }) : undefined
  const additional = artifacts
    ? await collectSecondary(artifacts.working, artifacts.data, workspaces, git, history)
    : { archives: history, secondary: undefined, readers: [] }
  const secondary = new Set(
    stores?.flatMap((store) => (store.kind === "raya" && store.content ? [identity(store.content.source.data)] : [])) ??
      [],
  )
  const data = [
    ...new Set([artifacts?.data ?? located.data, ...(artifacts?.globals?.map((scope) => scope.data) ?? [])]),
  ].filter((file) => !secondary.has(identity(file)))
  const notes = artifacts ? await collectNotes(artifacts.working, { data, workspaces, sql: collected.sql }) : undefined
  const claims =
    artifacts && notes
      ? notes.plans
          .filter((item) => item.scope === "data")
          .flatMap((item) => [
            bindDisposition(artifacts.working, path.join(item.root, "plans", item.name), notes),
            ...(item.sidecar
              ? [
                  bindDisposition(
                    artifacts.working,
                    path.join(item.root, "plans", PlanArtifact.sidecar(item.name)),
                    notes,
                  ),
                ]
              : []),
          ])
      : []
  const sql = artifacts ? await bindSQL(artifacts.working, { sql: collected.sql, exports, stores }) : undefined
  const config = artifacts?.config ? await bindConfig(artifacts.working, artifacts.config, "selected") : undefined
    const markdown = artifacts?.config ? bindMarkdown(artifacts.working, artifacts.config) : undefined
  const correspondence = artifacts
    ? await bindGit(artifacts.working, { artifacts: git, secondary: additional.secondary })
    : undefined
  const host = await held(located.data, artifacts?.host)
  const capsule = artifacts?.hostProof ? bindHost(artifacts.working, artifacts.hostProof, host) : undefined
  const models = artifacts?.hostProof ? await bindHostModel(artifacts.working, artifacts.hostProof, host) : undefined
  const speech = artifacts ? await readVoice(artifacts.working) : undefined
  const voice = artifacts && speech ? voiceValues(artifacts.working, speech) : undefined
  const spoken = artifacts && speech ? bindVoice(artifacts.working, speech, { voice }) : undefined
  const policy = artifacts ? await readOperational(artifacts.working) : undefined
  const operational = artifacts && policy ? operationalValues(artifacts.working, policy) : undefined
  const omitted = artifacts && policy ? bindOperational(artifacts.working, policy, { operational }) : undefined
  const archive = artifacts ? await readHistorical(artifacts.working) : undefined
  const restored =
    artifacts && archive
      ? await bindRestoredGit(artifacts.working, archive, { archives: additional.archives })
      : undefined
  const restoredArtifacts = artifacts && restored ? restoredGitValues(artifacts.working, restored) : undefined
  const prior =
    artifacts && archive
      ? await bindRestoredComponents(artifacts.working, archive, { archives: additional.archives })
      : undefined
  const restoredComponents = artifacts && prior ? restoredComponentValues(artifacts.working, prior) : undefined
  const tui = artifacts ? await collectTui(artifacts.working, artifacts.states ?? []) : undefined
  const display = artifacts ? await bindTui(artifacts.working, { tui }) : undefined
  const original =
    artifacts && archive
      ? await bindRestoredSources(artifacts.working, archive, { archives: additional.archives })
      : undefined
  const restoredSources = artifacts && original ? restoredSourceValues(artifacts.working, original) : undefined
  const hold = artifacts ? await bindHold(artifacts.working, { memory, secondary: additional.secondary }) : undefined
  const remembered =
    artifacts && reader
      ? bindMemory(artifacts.working, [reader, ...additional.readers], { memory, secondary: additional.secondary })
      : undefined
  const stored = artifacts ? await bindStorage(artifacts.working, { json, sql: collected.sql }) : undefined
  const drafts = artifacts ? await bindComposer(artifacts.working, { json, composers, sql: collected.sql }) : undefined
  const derived = artifacts
    ? await bindMemoryDerived(artifacts.working, { memory, secondary: additional.secondary })
    : undefined
  const metadata = artifacts
    ? await bindGitMetadata(artifacts.working, { artifacts: git, secondary: additional.secondary })
    : undefined
  assertCapture(proof, roots)
  return seal(
    payload.parse({
      format: "raya.profile-data",
      version: 1,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...collected,
      config: artifacts?.config,
      disposition: artifacts
        ? collectDisposition(
            artifacts.working,
            claims,
            "selected",
            sql,
            config,
            correspondence,
            capsule,
            remembered,
            stored,
            metadata,
            spoken,
            models,
            drafts,
            derived,
            omitted,
            restored,
            prior,
            display,
            original,
            hold,
            markdown,
          )
        : undefined,
      composers,
      stores,
      selfHeal: artifacts?.selfHealScopes
        ? await collectSelfHeal(artifacts.working, artifacts.selfHealScopes)
        : undefined,
      outputs: artifacts
        ? await collectOutputs(artifacts.working, {
            data,
            sql: collected.sql,
          })
        : undefined,
      notes,
      workspaces,
      memory,
      archives: additional.archives,
      secondary: additional.secondary,
      preferences,
      exports,
      artifacts: git,
      host,
      voice,
      operational,
      restoredArtifacts,
      restoredComponents,
      restoredSources,
      tui,
      json,
      review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
    }),
    password,
  )
}
