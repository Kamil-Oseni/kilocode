import { createHash } from "node:crypto"
import path from "node:path"
import { Database } from "bun:sqlite"
import z from "zod"
import { DraftError, DraftImported, DraftLegacy, DraftRetirement } from "../session/composer-codec"
import { composers, collectComposers } from "./profile-composers"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { read } from "./profile-file"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const document = "raya/composer-drafts.json"
const marker = "raya/composer-drafts-initialized.json"
const mark = z.union([z.object({ version: z.literal(1) }).strict(), DraftImported])
export const composerJSON = z
  .object({
    kind: z.literal("composer-json"),
    componentDigest: digest,
    legacyDigest: digest,
    selector: z.enum(["document", "marker"]),
    relation: z.enum(["current-content", "inert-historical", "retired-sql-control"]),
    storage: absolute,
    database: absolute,
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(32 * 1024 * 1024),
    digest,
    activation: z.literal("inert"),
  })
  .strict()
export type ComposerComponents = Readonly<{
  json: readonly Readonly<{ path: string; value: string }>[]
  composers?: z.output<typeof composers>
  sql?: readonly Readonly<{
    table: string
    columns: readonly string[]
    rows: readonly (readonly (string | number | null)[])[]
  }>[]
}>
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex")
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
function component(input: ComposerComponents) {
  if (input.json.length > 20000 || new Set(input.json.map((item) => item.path)).size !== input.json.length)
    throw new Error("Composer JSON inventory differs")
  if (input.json.reduce((size, item) => size + Buffer.byteLength(item.value), 0) > 96 * 1024 * 1024)
    throw new Error("Composer JSON inventory exceeds bound")
  return {
    json: input.json,
    composers: input.composers ? composers.parse(input.composers) : undefined,
    sql: input.sql?.filter((table) => ["raya_composer_control", "raya_composer_draft"].includes(table.table)),
  }
}
function pair(input: ComposerComponents) {
  const selected = (file: string) => input.json.find((item) => item.path === file)
  const source = selected(document)
  const stamp = selected(marker)
  if (!source || !stamp || Buffer.byteLength(source.value) > 32 * 1024 * 1024 || Buffer.byteLength(stamp.value) > 4096)
    return undefined
  const checked = (() => {
    try {
      const raw = JSON.parse(source.value)
      if (raw?.version === 2) {
        const value = DraftRetirement.schema.parse(raw)
        const paired = DraftRetirement.schema.parse(JSON.parse(stamp.value))
        if (JSON.stringify(value) !== JSON.stringify(paired)) return undefined
        return value
      }
      const value = DraftLegacy.checked(raw)
      if (!mark.safeParse(JSON.parse(stamp.value)).success) return undefined
      return value
    } catch (err) {
      if (err instanceof Error) return undefined
      throw err
    }
  })()
  if (!checked) return undefined
  return { source, stamp, checked }
}
function retired(
  input: ComposerComponents,
  selected: NonNullable<ReturnType<typeof pair>>,
  storage: string,
  database: string,
) {
  if (selected.checked.version !== 2) return false
  const controls = input.sql?.filter((table) => table.table === "raya_composer_control") ?? []
  if (controls.length !== 1 || controls[0].rows.length !== 1) return false
  const table = controls[0]
  const raw = Object.fromEntries(table.columns.map((column, index) => [column, table.rows[0][index]]))
  const row = z
    .object({
      id: z.literal("profile-v1"),
      phase: z.literal("active"),
      generation: z.string().uuid(),
      storage: z.literal(`raya.profile.json:${key(storage)}`),
      database: z.literal(`raya.profile.sqlite:${key(database)}`),
      source: z.string().nullable(),
      marker: z.string().nullable(),
      source_digest: digest,
      marker_digest: digest,
      cursor_secret: digest,
      content_bytes: z
        .number()
        .int()
        .nonnegative()
        .max(32 * 1024 * 1024),
      metadata_bytes: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024),
    })
    .strict()
    .safeParse(raw)
  if (
    !row.success ||
    hash(row.data.source) !== row.data.source_digest ||
    hash(row.data.marker) !== row.data.marker_digest
  )
    return false
  try {
    DraftRetirement.validate(row.data)
  } catch (err) {
    if (err instanceof DraftError) return false
    throw err
  }
  return JSON.stringify(DraftRetirement.encode(row.data)) === JSON.stringify(selected.checked)
}
export function validateComposer(input: z.input<typeof composerJSON>, content: ComposerComponents) {
  const entry = composerJSON.parse(input)
  const value = component(content)
  const selected = pair(value)
  if (!selected || hash(value) !== entry.componentDigest || hash(selected.checked) !== entry.legacyDigest)
    throw new Error("Composer JSON component differs")
  const relation =
    selected.checked.version === 2
      ? retired(value, selected, entry.storage, entry.database)
        ? "retired-sql-control"
        : undefined
      : hash(selected.checked) === hash(value.composers)
        ? "current-content"
        : "inert-historical"
  if (entry.relation !== relation || !value.composers) throw new Error("Composer JSON content relation differs")
  const item = entry.selector === "document" ? selected.source : selected.stamp
  if (
    key(entry.source) !== key(path.join(entry.storage, ...item.path.split("/"))) ||
    entry.bytes !== Buffer.byteLength(item.value) ||
    entry.digest !== sha(item.value)
  )
    throw new Error("Composer JSON original bytes differ")
}
const brand: unique symbol = Symbol("held-composer-json")
export type ComposerClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; groups: readonly z.output<typeof composerJSON>[] }>()
export async function bindComposer(token: Working, input: ComposerComponents): Promise<ComposerClaim> {
  const image = assertWorking(token)
  const native = inventory(token)
  const roots = [
    ...new Map(
      image.original
        .filter((root) => root.kind === "json" && key(lookup(token, root.path)) === key(image.profile.storage))
        .map((root) => [key(root.path), root.path]),
    ).values(),
  ]
  if (
    roots.length !== 1 ||
    !image.namespaces.some(
      (entry) =>
        key(entry.staged.data) === key(image.profile.data) &&
        key(path.join(entry.original.data, "storage")) === key(roots[0]),
    )
  )
    throw new Error("Composer JSON lacks primary Global storage binding")
  const value = component(input)
  const databases = native.roots.filter(
    (root) =>
      root.kind === "sqlite" && !root.absent && key(lookup(token, root.path, "sqlite")) === key(image.profile.database),
  )
  if (databases.length !== 1) throw new Error("Composer JSON lacks primary native SQLite binding")
  const db = new Database(image.profile.database, { readonly: true })
  const tables = (() => {
    try {
      return ["raya_composer_control", "raya_composer_draft"].flatMap((table) => {
        const columns = z.array(z.object({ name: z.string() })).parse(db.query(`PRAGMA table_info("${table}")`).all())
        if (!columns.length) return []
        return [
          {
            table,
            columns: columns.map((column) => column.name),
            rows: z
              .array(z.array(z.union([z.string(), z.number(), z.null()])))
              .parse(db.query(`SELECT * FROM "${table}"`).values()),
          },
        ]
      })
    } finally {
      db.close()
    }
  })()
  const actual = await collectComposers(tables, image.profile.storage)
  if (hash(actual) !== hash(value.composers)) throw new Error("Composer component differs from actual held reader")
  const selected = pair(value)
  if (
    selected?.checked.version === 2 &&
    hash(component({ json: value.json, composers: actual, sql: tables })) !== hash(value)
  )
    throw new Error("Composer SQL journal differs from actual held reader")
  const groups: z.output<typeof composerJSON>[] = []
  if (selected && actual && (selected.checked.version === 1 || retired(value, selected, roots[0], databases[0].path))) {
    for (const role of ["document", "marker"] as const) {
      const item = role === "document" ? selected.source : selected.stamp
      const source = path.join(roots[0], ...item.path.split("/"))
      const files = native.files.filter((file) => key(file.path) === key(source))
      if (files.length !== 1) throw new Error("Composer JSON lacks exact native file")
      const record = files[0]
      const bytes = await read(path.join(image.profile.storage, ...item.path.split("/")), 32 * 1024 * 1024)
      if (bytes.value !== item.value || bytes.bytes !== record.bytes || sha(bytes.value) !== record.digest)
        throw new Error("Composer JSON differs from held native bytes")
      const entry = composerJSON.parse({
        kind: "composer-json",
        componentDigest: hash(value),
        legacyDigest: hash(selected.checked),
        selector: role,
        relation:
          selected.checked.version === 2
            ? "retired-sql-control"
            : hash(selected.checked) === hash(actual)
              ? "current-content"
              : "inert-historical",
        storage: roots[0],
        database: databases[0].path,
        source: record.path,
        dev: record.dev,
        ino: record.ino,
        bytes: record.bytes,
        digest: record.digest,
        activation: "inert",
      })
      validateComposer(entry, value)
      groups.push(Object.freeze(entry))
    }
  }
  inventory(token)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, groups: Object.freeze(groups) })
  return claim
}
export function composerGroups(token: Working, proof: ComposerClaim) {
  inventory(token)
  const value = claims.get(proof)
  if (!value || value.token !== token) throw new Error("Composer JSON proof belongs to another image")
  return value.groups
}
