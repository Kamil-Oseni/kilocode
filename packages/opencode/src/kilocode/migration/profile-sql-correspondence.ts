import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { getTableName } from "drizzle-orm"
import z from "zod"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { AccountTable, AccountStateTable, ControlAccountTable } from "@opencode-ai/core/account/sql"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { assertWorking, inventory, type Working } from "./profile-image"
import { measure } from "./profile-sql"
import { captureJournal, journal } from "./profile-migration-journal"
import { allocator } from "./profile-sql-allocator-schema"
import { captureAllocator } from "./profile-sql-allocator"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const rows = (value: readonly unknown[]) => value.map((row) => JSON.stringify(row)).sort()
const omitted = new Set<string>(
  [CredentialTable, AccountTable, AccountStateTable, ControlAccountTable, PermissionTable, SessionShareTable].map(
    getTableName,
  ),
)
const entry = z
  .object({
    table: z.string().min(1).max(128),
    columns: z.array(z.string().min(1).max(128)).max(256),
    rows: z.number().int().safe().nonnegative(),
    disposition: z.enum([
      "selected",
      "credential-or-authority-omission",
      "inactive-migration-journal",
      "inactive-allocator-counters",
      "empty",
      "unclassified",
    ]),
    excluded: z.array(z.enum(["permission", "share_url"])).max(2),
  })
  .strict()
export const semantic = z
  .object({
    kind: z.literal("sqlite-semantic"),
    source: z.string().min(1).max(4096),
    component: z.enum(["sql", "exports", "store"]),
    id: digest.optional(),
    digest,
    schema: digest,
    tables: z.array(entry).max(256),
    complete: z.boolean(),
    recovery: z.literal("private-sqlite-checkpoint"),
    rawBytesPreserved: z.literal(false),
    journal: journal.optional(),
    allocator: allocator.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.component === "store") !== (value.id !== undefined))
      ctx.addIssue({ code: "custom", message: "SQL component selector differs" })
    if (
      new Set(value.tables.map((item) => item.table)).size !== value.tables.length ||
      value.complete !== !value.tables.some((item) => item.disposition === "unclassified")
    )
      ctx.addIssue({ code: "custom", message: "SQL table coverage differs" })
    if (
      value.tables.some(
        (item) =>
          (item.disposition === "empty" && item.rows !== 0) ||
          (item.disposition === "credential-or-authority-omission" && !omitted.has(item.table)),
      )
    )
      ctx.addIssue({ code: "custom", message: "SQL omission or empty-table evidence differs" })
    const migration = value.tables.find((item) => item.disposition === "inactive-migration-journal")
    if (
      (migration !== undefined) !== (value.journal !== undefined) ||
      (migration &&
        (migration.table !== "migration" ||
          JSON.stringify(migration.columns) !== JSON.stringify(["id", "time_completed"]) ||
          migration.rows !== value.journal?.rows.length))
    )
      ctx.addIssue({ code: "custom", message: "Inactive migration journal table binding differs" })
    const counter = value.tables.find((item) => item.disposition === "inactive-allocator-counters")
    if (
      (counter !== undefined) !== (value.allocator !== undefined) ||
      (counter &&
        (counter.table !== "sqlite_sequence" ||
          JSON.stringify(counter.columns) !== JSON.stringify(["name", "seq"]) ||
          counter.rows !== value.allocator?.rows.length ||
          value.allocator?.schema !== value.schema ||
          counter.excluded.length !== 0 ||
          value.component === "exports" ||
          !value.tables.some((item) => item.table === "raya_composer_draft" && item.disposition === "selected")))
    )
      ctx.addIssue({ code: "custom", message: "Inactive allocator table binding differs" })
  })
export type SQLComponents = Readonly<{
  sql: unknown
  exports?: unknown
  stores?: readonly { id: string; source: string; kind: string; sql?: unknown; evidence?: unknown; schema?: string }[]
}>
const select = (value: z.output<typeof semantic>, content: SQLComponents) => {
  if (value.component === "sql") return content.sql
  if (value.component === "exports") return content.exports
  const store = content.stores?.find((store) => store.id === value.id)
  if (!store || key(store.source) !== key(value.source) || store.schema !== value.schema) return undefined
  return store?.kind === "raya"
    ? store.sql
    : store?.kind === "session-export"
      ? store.evidence
      : store?.kind === "empty"
        ? { schema: store.schema }
        : undefined
}
export function validateSQL(value: z.input<typeof semantic>, content: SQLComponents) {
  const parsed = semantic.parse(value)
  const selected = select(parsed, content)
  if (selected === undefined || hash(selected) !== parsed.digest)
    throw new Error("SQLite correspondence component differs")
  if (
    parsed.component === "sql" ||
    (parsed.component === "store" && content.stores?.find((item) => item.id === parsed.id)?.kind === "raya")
  ) {
    const data = z
      .array(z.object({ table: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.unknown())) }))
      .parse(selected)
    if (parsed.allocator) {
      const draft = data.find((table) => table.table === "raya_composer_draft")
      const index = draft?.columns.indexOf("sequence") ?? -1
      if (!draft || index < 0) throw new Error("SQLite allocator selected target is missing")
      const values = z.array(z.number().int().safe().nonnegative()).parse(draft.rows.map((row) => row[index]))
      const highwater = values.reduce((maximum, value) => Math.max(maximum, value), 0)
      if (
        (parsed.allocator.rows.length === 0 && highwater !== 0) ||
        parsed.allocator.rows.some((row) => row.highwater !== highwater)
      )
        throw new Error("SQLite allocator selected high-water differs")
    }
    for (const table of data) {
      const entry = parsed.tables.find((item) => item.table === table.table)
      const excluded =
        table.table === "session"
          ? table.columns.filter((column) => column === "permission" || column === "share_url")
          : []
      if (
        !entry ||
        entry.disposition !== "selected" ||
        entry.rows !== table.rows.length ||
        JSON.stringify(entry.columns) !== JSON.stringify(table.columns) ||
        JSON.stringify(entry.excluded) !== JSON.stringify(excluded)
      )
        throw new Error("SQLite correspondence selected table differs")
    }
    if (
      parsed.tables.some(
        (entry) => entry.disposition === "selected" && !data.some((table) => table.table === entry.table),
      )
    )
      throw new Error("SQLite correspondence invents selected table")
  }
}
const freeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}
const bindings = new WeakMap<object, { token: Working; groups: readonly z.output<typeof semantic>[] }>()
const brand: unique symbol = Symbol("sqlite-semantic-binding")
export type SQLClaim = Readonly<{ [brand]: true }>

/** Bind recovered private readers to exact native DB/WAL/SHM groups and actual typed data. */
export async function bindSQL(token: Working, content: SQLComponents): Promise<SQLClaim> {
  const image = assertWorking(token)
  const raw = inventory(token)
  const { classify } = await import("./profile-stores")
  const { payload } = await import("./profile-bundle")
  const checked = { sql: payload.shape.sql.parse(content.sql), exports: content.exports, stores: content.stores }
  const groups = []
  for (const store of image.stores) {
    if (!store.present) continue
    if (!store.staged) throw new Error("SQLite correspondence recovered store missing")
    if (!raw.files.some((file) => key(file.path) === key(store.original)))
      throw new Error("SQLite correspondence native group missing")
    const category = await classify(store.staged)
    const primary = store.staged === image.profile.database
    const auxiliary = store.staged === image.profile.exports
    const extra = content.stores?.find((item) => key(item.source) === key(store.original))
    if (extra && extra.schema !== category.schema) throw new Error("SQLite correspondence store schema differs")
    const component = primary ? ("sql" as const) : auxiliary ? ("exports" as const) : ("store" as const)
    const provisional = { component, id: component === "store" ? extra?.id : undefined }
    const selected = primary
      ? checked.sql
      : auxiliary
        ? content.exports
        : extra?.kind === "raya"
          ? extra.sql
          : extra?.kind === "session-export"
            ? extra.evidence
            : extra?.kind === "empty"
              ? { schema: extra.schema }
              : undefined
    if (selected === undefined) throw new Error("SQLite correspondence payload missing")
    const db = new Database(store.staged, { readonly: true, strict: true })
    try {
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
      const coverage = []
      const migration =
        category.kind === "raya" ? captureJournal(db.query("SELECT id,time_completed FROM migration").all()) : undefined
      const portable = category.kind === "raya" ? payload.shape.sql.parse(selected) : undefined
      const counters = category.kind === "raya" ? captureAllocator(db, category.schema) : undefined
      for (const table of tables) {
        const columns = db
          .query<{ name: string }, []>(`PRAGMA table_info(${quote(table.name)})`)
          .all()
          .map((item) => item.name)
        const count = db.query<{ rows: number }, []>(`SELECT count(*) AS rows FROM ${quote(table.name)}`).get()!.rows
        const match = portable?.find((item) => item.table === table.name)
        const excluded =
          match && table.name === "session"
            ? columns.filter(
                (column): column is "permission" | "share_url" => column === "permission" || column === "share_url",
              )
            : []
        if (match) {
          if (JSON.stringify(match.columns) !== JSON.stringify(columns))
            throw new Error("SQLite correspondence columns differ")
          measure(db, table.name, columns)
          const actual = db
            .query(`SELECT * FROM ${quote(table.name)}`)
            .values()
            .map((row) =>
              row.map((value, index) => (excluded.some((column) => column === columns[index]) ? null : value)),
            )
          if (JSON.stringify(rows(actual)) !== JSON.stringify(rows(match.rows)))
            throw new Error("SQLite correspondence selected rows differ")
        }
        coverage.push({
          table: table.name,
          columns,
          rows: count,
          disposition: match
            ? ("selected" as const)
            : omitted.has(table.name)
              ? ("credential-or-authority-omission" as const)
              : table.name === "migration" && migration
                ? ("inactive-migration-journal" as const)
                : table.name === "sqlite_sequence" && counters
                  ? ("inactive-allocator-counters" as const)
                  : count === 0
                    ? ("empty" as const)
                    : ("unclassified" as const),
          excluded,
        })
      }
      if (category.kind === "session-export") {
        const { evidence } = await import("./profile-exports")
        if (hash(await evidence(store.staged)) !== hash(selected)) throw new Error("SQLite export evidence differs")
        for (const table of coverage) if (["event", "chunk"].includes(table.table)) table.disposition = "selected"
      }
      groups.push(
        semantic.parse({
          kind: "sqlite-semantic",
          source: store.original,
          ...provisional,
          digest: hash(selected),
          schema: category.schema,
          tables: coverage,
          complete: !coverage.some((item) => item.disposition === "unclassified"),
          recovery: "private-sqlite-checkpoint",
          rawBytesPreserved: false,
          journal: migration,
          allocator: counters,
        }),
      )
    } finally {
      db.close()
    }
  }
  assertWorking(token)
  const claim = Object.freeze({ [brand]: true as const })
  bindings.set(claim, { token, groups: freeze(groups) })
  return claim
}
export function sqlGroups(token: Working, claim: SQLClaim) {
  assertWorking(token)
  const value = bindings.get(claim)
  if (!value || value.token !== token) throw new Error("SQLite correspondence binding is absent")
  return value.groups
}
