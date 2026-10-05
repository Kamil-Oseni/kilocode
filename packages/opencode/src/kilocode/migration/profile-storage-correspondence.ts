import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { ID as SessionID } from "@opencode-ai/core/session/schema"
import z from "zod"
import { Database } from "bun:sqlite"
import { Codec as Task } from "../task/schema"
import { Codec as Goal } from "../goal/schema"
import { Codec as Checkpoint } from "../checkpoint/schema"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { goalStop } from "./profile-goal-stop-correspondence"
import { measure } from "./profile-sql"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !/[\\:\0\r\n]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== ".."),
  )
const role = z.enum(["workers", "initialization", "runs", "goal", "checkpoint", "goal-stop"])
const policy = {
  workers: "disabled-remapped",
  initialization: "initialization-marker",
  runs: "terminal-runs-reset-events",
  goal: "paused-without-recovery",
  checkpoint: "typed-inactive-checkpoints",
  "goal-stop": "historical-stop-without-execution-authority",
} as const
export const storageJSON = z
  .object({
    kind: z.literal("storage-json"),
    component: z.literal("json"),
    componentDigest: digest,
    sqlDigest: digest.optional(),
    selector: z.object({ role, path: relative }).strict(),
    storage: absolute,
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
    restoration: z.enum(Object.values(policy)),
    activation: z.literal("inert"),
  })
  .strict()
  .refine((value) => value.restoration === policy[value.selector.role], "Storage restoration policy differs")
  .refine(
    (value) => (value.selector.role === "goal-stop") === (value.sqlDigest !== undefined),
    "Stop SQL binding is missing",
  )
export type StorageComponents = Readonly<{
  json: readonly Readonly<{ path: string; value: string }>[]
  sql?: readonly Readonly<{
    table: string
    columns: readonly string[]
    rows: readonly (readonly (string | number | null)[])[]
  }>[]
}>
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const sum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
function selected(file: string) {
  if (file === "raya/agent.json") return "workers" as const
  if (file === "raya/agent-initialized.json") return "initialization" as const
  if (/^raya\/agent-runs\/[^/]+\.json$/.test(file)) return "runs" as const
  if (/^raya\/goal\/[^/]+\.json$/.test(file)) return "goal" as const
  if (/^raya\/checkpoint\/[^/]+\.json$/.test(file)) return "checkpoint" as const
  if (/^raya\/goal-stops\/[^/]+\/[a-f0-9]{64}\.json$/.test(file)) return "goal-stop" as const
  return undefined
}
function decode(file: string, raw: string, content?: StorageComponents) {
  const kind = selected(file)
  if (!kind) return undefined
  if (kind === "goal-stop") return content && goalStop(file, raw, content) ? kind : undefined
  if ((kind === "goal" || kind === "checkpoint") && !Schema.is(SessionID)(file.slice(file.lastIndexOf("/") + 1, -5)))
    return undefined
  const value: unknown = JSON.parse(raw)
  const opts = { onExcessProperty: "error" as const }
  if (kind === "workers") {
    const result = Schema.decodeUnknownOption(Schema.Array(Task.Agent))(value, opts)
    if (Option.isNone(result) || new Set(result.value.map((item) => item.id)).size !== result.value.length)
      return undefined
    return kind
  }
  if (kind === "initialization") {
    const result = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.Literal(1) }))(value, opts)
    return Option.isSome(result) ? kind : undefined
  }
  if (kind === "runs") {
    const result = Schema.decodeUnknownOption(Task.History)(value, opts)
    const id = file.slice("raya/agent-runs/".length, -5)
    if (
      Option.isNone(result) ||
      result.value.runs.some((run) => run.agentID !== id) ||
      result.value.events.some((event) => event.agentID !== id)
    )
      return undefined
    return kind
  }
  if (kind === "goal") return Option.isSome(Schema.decodeUnknownOption(Goal.State)(value, opts)) ? kind : undefined
  return Option.isSome(Schema.decodeUnknownOption(Checkpoint.List)(value, opts)) ? kind : undefined
}
function component(input: StorageComponents) {
  if (input.json.length > 20_000 || new Set(input.json.map((item) => item.path)).size !== input.json.length)
    throw new Error("Storage JSON component inventory differs")
  for (const item of input.json) {
    relative.parse(item.path)
    if (Buffer.byteLength(item.value) > 32 * 1024 * 1024) throw new Error("Storage JSON component exceeds bound")
  }
  if (input.json.reduce((size, item) => size + Buffer.byteLength(item.value), 0) > 96 * 1024 * 1024)
    throw new Error("Storage JSON component exceeds shared bound")
  return z
    .array(z.object({ path: relative, value: z.string() }).strict())
    .max(20_000)
    .parse(input.json)
}
export function validateStorage(input: z.input<typeof storageJSON>, content: StorageComponents) {
  const entry = storageJSON.parse(input)
  const json = component(content)
  if (hash(json) !== entry.componentDigest) throw new Error("Storage JSON correspondence component differs")
  const matches = json.filter((item) => item.path === entry.selector.path)
  if (entry.selector.role === "goal-stop" && (!content.sql || hash(content.sql) !== entry.sqlDigest))
    throw new Error("Goal Stop correspondence SQL component differs")
  if (matches.length !== 1 || decode(matches[0].path, matches[0].value, content) !== entry.selector.role)
    throw new Error("Storage JSON correspondence typed selector differs")
  const bytes = Buffer.from(matches[0].value)
  if (
    bytes.length !== entry.bytes ||
    sum(bytes) !== entry.digest ||
    key(path.join(entry.storage, ...entry.selector.path.split("/"))) !== key(entry.source)
  )
    throw new Error("Storage JSON correspondence original bytes differ")
}
const brand: unique symbol = Symbol("held-storage-json-correspondence")
export type StorageClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; groups: readonly z.output<typeof storageJSON>[] }>()
/** Only actual primary storage bytes and the shipped writer schemas can mint this live claim. */
export async function bindStorage(token: Working, input: StorageComponents): Promise<StorageClaim> {
  const image = assertWorking(token)
  const native = inventory(token)
  const roots = image.original.filter(
    (root) => root.kind === "json" && key(lookup(token, root.path)) === key(image.profile.storage),
  )
  const paths = [...new Map(roots.map((root) => [key(root.path), root.path])).values()]
  if (paths.length !== 1) throw new Error("Storage JSON correspondence lacks exact primary storage mapping")
  const globals = image.namespaces.filter((entry) => key(entry.staged.data) === key(image.profile.data))
  if (!globals.length || globals.some((entry) => key(path.join(entry.original.data, "storage")) !== key(paths[0])))
    throw new Error("Storage JSON correspondence lacks actual primary Global binding")
  const json = component(input)
  if (input.sql && json.some((item) => selected(item.path) === "goal-stop")) {
    const sessions = input.sql.filter((table) => table.table === "session")
    if (sessions.length !== 1) throw new Error("Goal Stop correspondence lacks its session table")
    const table = sessions[0]
    const db = new Database(image.profile.database, { readonly: true, strict: true })
    try {
      measure(db, "session", ["id", "metadata"])
      const actual = db
        .query<{ id: string; metadata: string | null }, []>("SELECT id,metadata FROM session ORDER BY id")
        .all()
      const expected = table.rows
        .map((row) => ({ id: row[table.columns.indexOf("id")], metadata: row[table.columns.indexOf("metadata")] }))
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
      if (hash(actual) !== hash(expected)) throw new Error("Goal Stop session metadata differs from recovered SQL")
    } finally {
      db.close()
    }
    inventory(token)
  }
  const groups: z.output<typeof storageJSON>[] = []
  for (const item of json) {
    const kind = selected(item.path)
    if (!kind) continue
    const source = path.join(paths[0], ...item.path.split("/"))
    const files = native.files.filter((file) => key(file.path) === key(source))
    if (files.length !== 1) throw new Error("Storage JSON correspondence lacks exact native file")
    const record = files[0]
    const staged = path.join(image.profile.storage, ...item.path.split("/"))
    const bytes = await readFile(staged)
    inventory(token)
    if (!bytes.equals(Buffer.from(item.value)) || bytes.length !== record.bytes || sum(bytes) !== record.digest)
      throw new Error("Storage JSON correspondence differs from held original bytes")
    if (decode(item.path, item.value, input) !== kind) continue
    const entry = storageJSON.parse({
      kind: "storage-json",
      component: "json",
      componentDigest: hash(json),
      ...(kind === "goal-stop" ? { sqlDigest: hash(input.sql) } : {}),
      selector: { role: kind, path: item.path },
      storage: paths[0],
      source: record.path,
      dev: record.dev,
      ino: record.ino,
      bytes: record.bytes,
      digest: record.digest,
      restoration: policy[kind],
      activation: "inert",
    })
    validateStorage(entry, input)
    groups.push(Object.freeze({ ...entry, selector: Object.freeze(entry.selector) }))
  }
  inventory(token)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, groups: Object.freeze(groups) })
  return claim
}
export function storageGroups(token: Working, claim: StorageClaim) {
  inventory(token)
  const state = claims.get(claim)
  if (!state || state.token !== token) throw new Error("Storage JSON correspondence belongs to another image")
  return state.groups
}
