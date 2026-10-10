import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import z from "zod"
import { declarations } from "./profile-routine-declarations"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const normalize = (value: string) => value.trim().replace(/;$/, "").replace(/\s+/g, " ")
const id = z.string().regex(/^[a-f0-9]{32}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const text = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && Buffer.byteLength(value) <= 256)
const birth = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n)
const scalar = z.union([z.string().max(256), z.number().int().safe(), z.null()])
const schemas = {
  raya_routine_effect_attempt: z
    .object({
      id,
      capsule: id,
      generation: id,
      kind: z.enum(["model", "tool", "mcp", "browser", "native"]),
      purpose: text,
      digest,
      owner: digest,
      state: z.enum(["reserved", "started", "settled", "refused", "uncertain"]),
      receipt: digest.nullable(),
    })
    .strict()
    .refine((value) => (value.state === "settled") === (value.receipt !== null)),
  raya_routine_effect_capsule: z
    .object({
      id,
      participant: id,
      generation: id,
      run: text,
      session: text,
      step: text,
      owner: digest,
      projection: digest,
      state: z.enum(["inactive", "active", "revoked", "retired"]),
    })
    .strict(),
  raya_routine_effect_membership: z.object({ capsule: id, scope: digest, generation: id }).strict(),
  raya_routine_effect_participant: z
    .object({
      id,
      profile: digest,
      protocol: z.literal("raya.routine.effect.v1"),
      cohort: digest,
      pid: z.number().int().min(1).max(4294967295),
      birth,
      state: z.enum(["inactive", "qualified", "revoked", "retired"]),
    })
    .strict(),
  raya_routine_effect_revocation: z
    .object({
      id,
      scope: digest,
      generation: id,
      projection: digest,
      request: digest,
      reason: text,
      state: z.enum(["requested", "published", "uncertain"]),
    })
    .strict(),
  raya_routine_effect_scope: z
    .object({
      id: digest,
      kind: z.enum(["principal", "organization", "goal", "run", "session", "delegation", "workspace", "config"]),
      principal: text,
      birth,
      generation: id,
      projection: digest,
      state: z.enum(["inactive", "active", "revoking", "retired"]),
    })
    .strict(),
}
export const names = Object.freeze(Object.keys(schemas) as (keyof typeof schemas)[])
const columns = {
  raya_routine_effect_attempt: [
    "id",
    "capsule",
    "generation",
    "kind",
    "purpose",
    "digest",
    "owner",
    "state",
    "receipt",
  ],
  raya_routine_effect_capsule: [
    "id",
    "participant",
    "generation",
    "run",
    "session",
    "step",
    "owner",
    "projection",
    "state",
  ],
  raya_routine_effect_membership: ["capsule", "scope", "generation"],
  raya_routine_effect_participant: ["id", "profile", "protocol", "cohort", "pid", "birth", "state"],
  raya_routine_effect_revocation: ["id", "scope", "generation", "projection", "request", "reason", "state"],
  raya_routine_effect_scope: ["id", "kind", "principal", "birth", "generation", "projection", "state"],
}
const objects = declarations
  .map((sql) => {
    const match = /^CREATE (TABLE|(?:UNIQUE )?INDEX) `([^`]+)`(?: ON `([^`]+)`)?/.exec(sql)!
    return {
      type: match[1] === "TABLE" ? "table" : "index",
      name: match[2],
      tbl_name: match[3] ?? match[2],
      sql: normalize(sql) as string | null,
    }
  })
  .concat(names.map((name) => ({ type: "index", name: `sqlite_autoindex_${name}_1`, tbl_name: name, sql: null })))
const order = <T extends { type: string; name: string }>(value: T[]) =>
  value.sort((a, b) => a.type.localeCompare(b.type, "en") || a.name.localeCompare(b.name, "en"))
const cohort = hash(order(objects))
const shape = z
  .object({
    type: z.enum(["table", "index"]),
    name: z.string().max(128),
    tbl_name: z.string().max(128),
    sql: z.string().max(65536).nullable(),
  })
  .strict()
const table = z
  .object({
    table: z.enum(names as readonly [keyof typeof schemas, ...(keyof typeof schemas)[]]),
    columns: z.array(z.string().max(128)).max(9),
    rows: z.array(z.array(scalar).max(9)).max(8192),
    digest,
  })
  .strict()
function fences(value: z.output<typeof table>[]) {
  const records: Record<string, Record<string, z.output<typeof scalar>>[]> = Object.fromEntries(
    value.map((item) => [
      item.table,
      item.rows.map((row) => Object.fromEntries(item.columns.map((column, index) => [column, row[index]]))),
    ]),
  )
  const participants = new Map(records.raya_routine_effect_participant.map((row) => [row.id, row]))
  const capsules = new Map(records.raya_routine_effect_capsule.map((row) => [row.id, row]))
  const scopes = new Map(records.raya_routine_effect_scope.map((row) => [row.id, row]))
  const unique = (rows: (typeof records)[string], key: (row: (typeof rows)[number]) => unknown) => {
    if (new Set(rows.map(key)).size !== rows.length) throw new Error("Routine effect quarantine identity differs")
  }
  for (const name of names)
    unique(records[name], (row) =>
      name === "raya_routine_effect_membership" ? JSON.stringify([row.capsule, row.scope]) : row.id,
    )
  unique(records.raya_routine_effect_capsule, (row) => JSON.stringify([row.run, row.session, row.step]))
  unique(records.raya_routine_effect_scope, (row) => JSON.stringify([row.kind, row.principal, row.birth]))
  unique(records.raya_routine_effect_attempt, (row) => JSON.stringify([row.capsule, row.purpose]))
  unique(records.raya_routine_effect_revocation, (row) => JSON.stringify([row.scope, row.generation]))
  for (const row of records.raya_routine_effect_capsule)
    if (!participants.has(row.participant)) throw new Error("Routine effect quarantine participant missing")
  for (const row of records.raya_routine_effect_membership)
    if (!capsules.has(row.capsule) || !scopes.has(row.scope))
      throw new Error("Routine effect quarantine membership missing")
  for (const row of records.raya_routine_effect_revocation)
    if (!scopes.has(row.scope)) throw new Error("Routine effect quarantine scope missing")
  for (const row of records.raya_routine_effect_attempt) {
    const capsule = capsules.get(row.capsule)
    if (!capsule || capsule.generation !== row.generation || capsule.owner !== row.owner)
      throw new Error("Routine effect quarantine original attempt differs")
  }
  const attempts = new Map<z.output<typeof scalar>, (typeof records)[string]>()
  const members = new Map<z.output<typeof scalar>, number>()
  for (const row of records.raya_routine_effect_attempt) {
    const group = attempts.get(row.capsule) ?? []
    group.push(row)
    attempts.set(row.capsule, group)
  }
  for (const row of records.raya_routine_effect_membership)
    members.set(row.capsule, (members.get(row.capsule) ?? 0) + 1)
  for (const row of records.raya_routine_effect_capsule) {
    if ((members.get(row.id) ?? 0) < 1 || members.get(row.id)! > 64 || (attempts.get(row.id)?.length ?? 0) > 1024)
      throw new Error("Routine effect quarantine capsule capacity exceeded")
  }
  return records.raya_routine_effect_capsule.map((row) => ({
    capsule: row.id,
    generation: row.generation,
    owner: row.owner,
    run: row.run,
    session: row.session,
    step: row.step,
    attempts: (attempts.get(row.id) ?? []).map((attempt) => ({
      id: attempt.id,
      kind: attempt.kind,
      purpose: attempt.purpose,
      digest: attempt.digest,
      state: attempt.state,
      receipt: attempt.receipt,
    })),
  }))
}
const fence = z
  .object({
    capsule: id,
    generation: id,
    owner: digest,
    run: text,
    session: text,
    step: text,
    attempts: z
      .array(
        z
          .object({
            id,
            kind: schemas.raya_routine_effect_attempt.shape.kind,
            purpose: text,
            digest,
            state: z.enum(["reserved", "started", "settled", "refused", "uncertain"]),
            receipt: digest.nullable(),
          })
          .strict(),
      )
      .max(1024),
  })
  .strict()
const body = z
  .object({
    format: z.literal("raya.routine-effect-quarantine"),
    version: z.literal(1),
    activation: z.literal("inert"),
    installation: z.literal(false),
    cohort: z.literal(cohort),
    schema: z.array(shape).length(21),
    tables: z.array(table).length(6),
    fences: z.array(fence).max(8192),
  })
  .strict()
export const routineEffects = body.extend({ digest }).superRefine((value, ctx) => {
  try {
    if (
      Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024 ||
      hash(value.schema.map((row) => ({ ...row, sql: row.sql === null ? null : normalize(row.sql) }))) !== cohort
    )
      throw new Error("Routine effect quarantine schema or capacity differs")
    if (
      JSON.stringify(value.tables.map((row) => row.table)) !== JSON.stringify(names) ||
      value.tables.reduce((sum, row) => sum + row.rows.length, 0) > 8192
    )
      throw new Error("Routine effect quarantine table membership differs")
    for (const item of value.tables) {
      if (
        JSON.stringify(item.columns) !== JSON.stringify(columns[item.table]) ||
        hash({ columns: item.columns, rows: item.rows }) !== item.digest
      )
        throw new Error("Routine effect quarantine rows differ")
      if (
        JSON.stringify(item.rows) !==
        JSON.stringify([...item.rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en")))
      )
        throw new Error("Routine effect quarantine row order differs")
      for (const row of item.rows) {
        if (row.length !== item.columns.length) throw new Error("Routine effect quarantine row width differs")
        schemas[item.table].parse(Object.fromEntries(item.columns.map((column, index) => [column, row[index]])))
      }
    }
    if (
      JSON.stringify(fences(value.tables)) !== JSON.stringify(value.fences) ||
      hash(body.parse(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest")))) !== value.digest
    )
      throw new Error("Routine effect quarantine fences differ")
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : "Routine effect quarantine refused" })
  }
})

/** Bounded read of the exact original cohort; never inserts rows or executes archived DDL. */
export function measureRoutineEffects(db: Database) {
  const size = db
    .query<
      { count: number; bytes: number; maximum: number },
      []
    >("SELECT count(*) AS count,coalesce(sum(length(CAST(sql AS BLOB))),0) AS bytes,coalesce(max(length(CAST(sql AS BLOB))),0) AS maximum FROM sqlite_master WHERE name GLOB 'raya_routine_effect*' OR tbl_name GLOB 'raya_routine_effect*'")
    .get()!
  if (size.count === 0) return 0
  if (size.count !== 21 || size.bytes > 1048576 || size.maximum > 65536)
    throw new Error("Routine effect quarantine partial or unknown schema")
  let total = 0
  for (const name of names) {
    const actual = db.query<{ name: string; type: string }, []>(`PRAGMA table_info("${name}")`).all()
    if (
      JSON.stringify(actual.map((row) => row.name)) !== JSON.stringify(columns[name]) ||
      actual.some(
        (row) =>
          row.type.toLowerCase() !==
          (name === "raya_routine_effect_participant" && row.name === "pid" ? "integer" : "text"),
      )
    )
      throw new Error("Routine effect quarantine columns differ")
    const count = db.query<{ count: number }, []>(`SELECT count(*) AS count FROM "${name}"`).get()!.count
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Routine effect quarantine capacity exceeded")
    total += count
    if (total > 8192) throw new Error("Routine effect quarantine capacity exceeded")
  }
  // Reject malformed raw cells before any JSON function can expand them. All v1 text
  // columns hold at most 256 UTF-8 bytes; pid is the sole integer and receipt nullable.
  for (const name of names) {
    const values = columns[name].map((column) => `coalesce(length(CAST("${column}" AS BLOB)),0)`)
    const types = columns[name].map((column) =>
      column === "receipt"
        ? `typeof("${column}") IN ('text','null')`
        : `typeof("${column}")='${name === "raya_routine_effect_participant" && column === "pid" ? "integer" : "text"}'`,
    )
    const cell = db
      .query<
        { bytes: number; invalid: number },
        []
      >(`SELECT coalesce(max(max(${values.join(",")})),0) AS bytes,coalesce(max(CASE WHEN ${types.join(" AND ")} THEN 0 ELSE 1 END),0) AS invalid FROM "${name}"`)
      .get()!
    if (!Number.isSafeInteger(cell.bytes) || cell.bytes < 0 || cell.bytes > 256 || cell.invalid !== 0)
      throw new Error("Routine effect quarantine raw cell exceeds its declared contract")
  }
  let bytes = 0
  for (const name of names) {
    const sum = db
      .query<
        { bytes: number },
        []
      >(`SELECT coalesce(sum(length(CAST(json_array(${columns[name].map((column) => `"${column}"`).join(",")}) AS BLOB))),0) AS bytes FROM "${name}"`)
      .get()!
    if (!Number.isSafeInteger(sum.bytes) || sum.bytes < 0)
      throw new Error("Routine effect quarantine capacity exceeded")
    bytes += sum.bytes
    if (bytes > 8 * 1024 * 1024) throw new Error("Routine effect quarantine capacity exceeded")
  }
  return bytes + size.bytes
}

export function captureRoutineEffects(db: Database) {
  if (measureRoutineEffects(db) === 0) return undefined
  const schema = db
    .query<
      z.output<typeof shape>,
      []
    >("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'raya_routine_effect*' OR tbl_name GLOB 'raya_routine_effect*' ORDER BY type,name")
    .all()
  if (hash(schema.map((row) => ({ ...row, sql: row.sql === null ? null : normalize(row.sql) }))) !== cohort)
    throw new Error("Routine effect quarantine unknown schema")
  const tables = names.map((name) => {
    const rows = db
      .query(`SELECT * FROM "${name}" LIMIT 8193`)
      .values()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"))
    return table.parse({ table: name, columns: columns[name], rows, digest: hash({ columns: columns[name], rows }) })
  })
  const value = body.parse({
    format: "raya.routine-effect-quarantine",
    version: 1,
    activation: "inert",
    installation: false,
    cohort,
    schema,
    tables,
    fences: fences(tables),
  })
  return routineEffects.parse({ ...value, digest: hash(value) })
}
