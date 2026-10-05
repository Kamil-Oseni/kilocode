import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto"
import { z } from "zod"
import { memory } from "./profile-memory"
import { tui } from "./profile-tui"
import { preferences, sanitize } from "./profile-preferences"
import { identity, references } from "./profile-workspaces"
import { exports } from "./profile-exports"
import { artifacts } from "./profile-artifacts"
import { host } from "./profile-host"
import { composers, contents } from "./profile-composers"
import { notes } from "./profile-notes"
import { outputs } from "./profile-outputs"
import { selfHeal } from "./profile-self-heal"
import { schema as storeSchema } from "./profile-store-schema"
import { ConfigEvidence } from "./profile-config"
import { artifactUsage, secondary } from "./profile-secondary-schema"
import { disposition, validateDisposition } from "./profile-disposition"
import { voice } from "./profile-voice-reconciliation-schema"
import { operational } from "./profile-operational-schema"
import { restoredArtifacts } from "./profile-restored-git-schema"
import { validateRestoredArtifacts } from "./profile-restored-git-correspondence"
import { validateRestoredReceipts } from "./profile-restore-review-schema"
import { restoredComponents } from "./profile-restored-components-schema"
import { validateRestoredComponents } from "./profile-restored-components-correspondence"
import { restoredSources } from "./profile-restored-source-schema"
import { validateRestoredSources } from "./profile-restored-source-correspondence"

// This is a data allowlist, not a claim that the source writers have retired.
// Credentials, account state, permissions and public-share tokens are deliberately absent.
export const tables = [
  "workspace",
  "project",
  "project_directory",
  "session",
  "message",
  "part",
  "todo",
  "session_context_epoch",
  "session_input",
  "session_message",
  "event_sequence",
  "event",
  "raya_routine_archive",
  "raya_routine_archive_import",
  "raya_composer_control",
  "raya_composer_draft",
  "raya_contact_message",
  "raya_contact_destination",
  "raya_contact_receipt",
  "raya_routine_attachment",
  "raya_routine_conversation",
  "raya_routine_cursor",
  "raya_routine_delegation",
  "raya_routine_message",
  "raya_routine_occurrence",
  "raya_routine_organization_coordinator",
  "raya_routine_organization_delegation",
  "raya_routine_organization_member",
  "raya_routine_organization_reservation",
  "raya_routine_organization_revision",
  "raya_routine_organization",
  "raya_voice_binding",
] as const

const scalar = z.union([z.string().max(16_777_216), z.number().finite(), z.null()])
const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(128)
const uuid = z.string().uuid()
export const checkpoints = z
  .array(
    z
      .object({
        id: uuid,
        name: z.string().min(1).max(4096),
        hash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        createdAt: z.number().int().nonnegative().safe(),
      })
      .strict(),
  )
  .max(1000)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Duplicate checkpoint identity")
const json = z
  .string()
  .max(16_777_216)
  .superRefine((value, ctx) => {
    try {
      JSON.parse(value)
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected serialized JSON" })
    }
  })
const prefixes = [
  "raya/agent",
  "raya/agent-archive",
  "raya/agent-runs",
  "raya/agent-memory",
  "raya/agent-stage",
  "raya/agent-claims",
  "raya/agent-recovery",
  "raya/agent-starts",
  "raya/agent-executions",
  "raya/agent-execution-reviews",
  "raya/agent-removals",
  "raya/agent-initialized",
  "raya/scheduler-owners",
  "raya/scheduler-reviews",
  "raya/delegation-reviews",
  "raya/goal-stops",
  "raya/goal",
  "raya/checkpoint",
  "raya/delegation",
  "session",
  "message",
  "part",
  "project",
  "todo",
]
export const filename = z
  .string()
  .max(1024)
  .refine((value) => {
    if (!value.endsWith(".json") || value.includes("\\") || value.includes(":")) return false
    if (value === "raya/composer-drafts.json" || value === "raya/composer-drafts-initialized.json") return true
    if (value.startsWith("raya/checkpoint")) return /^raya\/checkpoint\/[^/]+\.json$/.test(value)
    const parts = value.split("/")
    if (parts.some((part) => !part || part === "." || part === "..")) return false
    const stem = value.slice(0, -5)
    return prefixes.some((prefix) => stem === prefix || stem.startsWith(`${prefix}/`))
  }, "JSON path is outside the portable data allowlist")

export const snapshot = z
  .object({
    format: z.literal("raya.profile-data"),
    version: z.literal(1),
    id: uuid,
    createdAt: z.number().int().nonnegative(),
    schema: z.string().regex(/^[a-f0-9]{64}$/),
    workspaces: z.array(z.string().min(1).max(4096)).max(10_000),
    sql: z
      .array(
        z
          .object({
            table: z.enum(tables),
            columns: z.array(identifier).min(1).max(256),
            rows: z.array(z.array(scalar).max(256)).max(1_000_000),
          })
          .strict()
          .transform((table) =>
            table.table !== "session"
              ? table
              : {
                  ...table,
                  rows: table.rows.map((row) =>
                    row.map((value, index) =>
                      ["permission", "share_url"].includes(table.columns[index]) ? null : value,
                    ),
                  ),
                },
          ),
      )
      .max(tables.length),
    json: z.array(z.object({ path: filename, value: json }).strict()).max(100_000),
    memory: z.array(memory).max(10_000).default([]),
    exports: exports.optional(),
    artifacts: artifacts.optional(),
    host: host.optional(),
    voice: voice.optional(),
    operational: operational.optional(),
    restoredArtifacts: restoredArtifacts.optional(),
    restoredComponents: restoredComponents.optional(),
    restoredSources: restoredSources.optional(),
    tui: tui.optional(),
    composers: composers.optional(),
    notes: notes.optional(),
    outputs: outputs.optional(),
    selfHeal: selfHeal.optional(),
    stores: storeSchema(tables).stores.optional(),
    config: ConfigEvidence.optional(),
    disposition: disposition.optional(),
    secondary: secondary.optional(),
    preferences: preferences.default(() => sanitize({}, {})),
    review: z
      .object({
        reconnectCredentials: z.literal(true),
        uncertainWork: z.literal("held-no-replay"),
      })
      .strict(),
  })

  .strict()
  .superRefine((value, ctx) => {
    try {
      if (value.disposition)
        validateDisposition(
          value.disposition,
          value.notes,
          value,
          value.config,
          value,
          value.host,
          value,
          value,
          value,
          value,
          value,
          value,
          value,
          value,
          value,
        )
      validateRestoredReceipts(
        [...(value.restoredComponents ?? []), ...(value.restoredArtifacts ?? [])].map((entry) => entry.context),
        value.disposition?.files ?? [],
      )
      references(value.sql)
      if (
        value.stores?.some(
          (store) =>
            store.kind === "raya" &&
            store.workspaces.some(
              (workspace) => !value.workspaces.some((declared) => identity(workspace) === identity(declared)),
            ),
        )
      )
        ctx.addIssue({ code: "custom", message: "Additional store workspace is not declared" })
      const drafts = contents(value.sql)
      if (drafts && value.composers && JSON.stringify(drafts) !== JSON.stringify(value.composers))
        ctx.addIssue({ code: "custom", message: "Portable composer content disagrees with source SQL" })
      if (
        (value.composers ?? drafts)?.entries.some(
          (entry) =>
            !value.workspaces.some(
              (workspace) =>
                identity(entry.identity.workspace) === identity(workspace) ||
                identity(entry.identity.workspace).startsWith(identity(workspace).replace(/\/$/, "") + "/"),
            ),
        )
      )
        ctx.addIssue({ code: "custom", message: "Portable composer workspace is not declared" })
      if (new Set(value.workspaces.map(identity)).size !== value.workspaces.length)
        ctx.addIssue({ code: "custom", message: "Duplicate canonical source workspace" })
      if (
        value.secondary?.namespaces.some((item) =>
          [
            ...item.memory.map((item) => item.workspace),
            ...(item.artifacts?.snapshots.map((item) => item.workspace) ?? []),
            ...(item.artifacts?.worktrees.map((item) => item.workspace) ?? []),
          ].some((workspace) => !value.workspaces.some((declared) => identity(workspace) === identity(declared))),
        )
      )
        ctx.addIssue({ code: "custom", message: "Secondary namespace workspace is undeclared" })
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : "Invalid declared workspace reference",
      })
    }
    if (new Set(value.sql.map((item) => item.table)).size !== value.sql.length)
      ctx.addIssue({ code: "custom", message: "Duplicate SQL table" })
    const memories = [...value.memory, ...(value.secondary?.namespaces.flatMap((item) => item.memory) ?? [])]
    if (memories.length > 10_000 || memories.reduce((sum, item) => sum + item.sessions.length, 0) > 10_000)
      ctx.addIssue({ code: "custom", message: "Memory exceeds the shared namespace inventory bound" })
    const inventories = [value.artifacts, ...(value.secondary?.namespaces.map((item) => item.artifacts) ?? [])].map(
      artifactUsage,
    )
    if (
      inventories.reduce((sum, item) => sum + item.bytes, 0) > 96 * 1024 * 1024 ||
      inventories.reduce((sum, item) => sum + item.nodes, 0) > 20_000 ||
      inventories.reduce((sum, item) => sum + item.repositories, 0) > 256 ||
      inventories.reduce((sum, item) => sum + item.bindings, 0) > 10_000
    )
      ctx.addIssue({ code: "custom", message: "Git artifacts exceed the shared namespace inventory bound" })
    if (new Set(value.json.map((item) => item.path)).size !== value.json.length)
      ctx.addIssue({ code: "custom", message: "Duplicate JSON path" })
    let count = 0
    for (const item of value.json.filter((item) => item.path.startsWith("raya/checkpoint/"))) {
      const match = /^raya\/checkpoint\/([^/]+)\.json$/.exec(item.path)
      const parsed = checkpoints.safeParse(
        (() => {
          try {
            return JSON.parse(item.value)
          } catch {
            return undefined
          }
        })(),
      )
      const sessions = value.sql.find((item) => item.table === "session")
      const session = sessions?.rows.find((row) => row[sessions.columns.indexOf("id")] === match?.[1])
      const project = sessions && session?.[sessions.columns.indexOf("project_id")]
      const directory = sessions && session?.[sessions.columns.indexOf("directory")]
      const snapshot = value.artifacts?.snapshots
        .filter(
          (item) =>
            item.project === project &&
            typeof directory === "string" &&
            (identity(directory) === identity(item.workspace) ||
              identity(directory).startsWith(identity(item.workspace) + "/")),
        )
        .sort((left, right) => right.workspace.length - left.workspace.length)[0]
      const repository = value.artifacts?.repositories.find((item) => item.id === snapshot?.repository)
      if (!match || !parsed.success || !session || (parsed.data.length > 0 && !repository)) {
        ctx.addIssue({ code: "custom", message: "Checkpoint metadata lacks its declared session and snapshot" })
        continue
      }
      count += parsed.data.length
      if (parsed.data.some((item) => item.hash.length !== (repository?.objectFormat === "sha256" ? 64 : 40)))
        ctx.addIssue({ code: "custom", message: "Checkpoint snapshot object format does not match" })
    }
    if (count > 10_000) ctx.addIssue({ code: "custom", message: "Checkpoint inventory exceeds its bound" })
    if (new Set(value.workspaces).size !== value.workspaces.length)
      ctx.addIssue({ code: "custom", message: "Duplicate source workspace" })
    if (
      value.artifacts &&
      [...value.artifacts.snapshots, ...value.artifacts.worktrees].some(
        (item) => !value.workspaces.some((workspace) => identity(workspace) === identity(item.workspace)),
      )
    )
      ctx.addIssue({ code: "custom", message: "Git artifact workspace is not declared" })
    if (
      new Set(value.memory.map((item) => identity(item.workspace))).size !== value.memory.length ||
      value.memory.some(
        (item) => !value.workspaces.some((workspace) => identity(workspace) === identity(item.workspace)),
      )
    )
      ctx.addIssue({ code: "custom", message: "Standalone memory workspace is duplicated or undeclared" })
    for (const item of value.sql) {
      if (
        new Set(item.columns).size !== item.columns.length ||
        item.rows.some((row) => row.length !== item.columns.length)
      )
        ctx.addIssue({ code: "custom", message: "SQL row/column shape mismatch" })
    }
  })

/** Historical snapshots are inert evidence. No recursive nesting or execution authority is accepted. */
export const payload = snapshot
  .safeExtend({ archives: z.array(snapshot).max(64).default([]) })
  .superRefine((value, ctx) => {
    for (const source of [value, ...value.archives]) {
      try {
        validateRestoredComponents(source.restoredComponents ?? [], { archives: value.archives })
        validateRestoredSources(source.restoredSources ?? [], { archives: value.archives })
        validateRestoredArtifacts(source.restoredArtifacts ?? [], { archives: value.archives })
        if (source.restoredArtifacts?.some((entry) => entry.archive === source.id))
          ctx.addIssue({ code: "custom", message: "Restored Git projection references its own snapshot" })
        if (source.restoredComponents?.some((entry) => entry.archive === source.id))
          ctx.addIssue({ code: "custom", message: "Restored component projection references its own snapshot" })
        if (
          source.restoredSources?.some(
            (entry) => entry.archive === source.id || entry.prior.some((prior) => prior.archive === source.id),
          )
        )
          ctx.addIssue({ code: "custom", message: "Restored source projection references its own snapshot" })
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: err instanceof Error ? err.message : "Invalid restored component provenance",
        })
      }
    }
    if (
      new Set(value.archives.map((item) => item.id)).size !== value.archives.length ||
      value.archives.some((item) => item.id === value.id)
    )
      ctx.addIssue({ code: "custom", message: "Duplicate archived source identity" })
    if (
      value.secondary?.namespaces.some((item) =>
        item.archives.some((id) => !value.archives.some((item) => item.id === id)),
      )
    )
      ctx.addIssue({ code: "custom", message: "Secondary archive provenance lacks its historical snapshot" })
  })

const envelope = z
  .object({
    format: z.literal("raya.encrypted-profile"),
    version: z.literal(1),
    cipher: z.literal("aes-256-gcm"),
    kdf: z.literal("scrypt-N32768-r8-p1"),
    salt: z.string().regex(/^[a-f0-9]{32}$/),
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    data: z
      .string()
      .max(268_435_456)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()
const aad = Buffer.from("raya.encrypted-profile/v1/aes-256-gcm/scrypt-N32768-r8-p1")
async function key(password: string, salt: Buffer) {
  if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024)
    throw new Error("Use a passphrase between 12 and 1024 bytes")
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, value) =>
      err ? reject(err) : resolve(value),
    )
  })
}

/** Internal codec: callers must obtain held, complete capture authority before collecting source data. */
export async function seal(value: z.input<typeof payload>, password: string) {
  const checked = payload.parse(value)
  const bytes = Buffer.from(JSON.stringify(checked))
  if (bytes.length > 128 * 1024 * 1024) throw new Error("Portable profile exceeds the supported bundle size")
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", await key(password, salt), nonce)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(bytes), cipher.final()])
  return JSON.stringify({
    format: "raya.encrypted-profile",
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt-N32768-r8-p1",
    salt: salt.toString("hex"),
    nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("base64"),
  })
}

/** Authenticate before interpreting paths or constructing any destination file. */
export async function unseal(text: string, password: string) {
  if (Buffer.byteLength(text) > 180 * 1024 * 1024)
    throw new Error("Encrypted profile exceeds the supported bundle size")
  const checked = envelope.parse(JSON.parse(text))
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await key(password, Buffer.from(checked.salt, "hex")),
    Buffer.from(checked.nonce, "hex"),
  )
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(checked.tag, "hex"))
  const bytes = Buffer.concat([decipher.update(Buffer.from(checked.data, "base64")), decipher.final()])
  return payload.parse(JSON.parse(bytes.toString("utf8")))
}
