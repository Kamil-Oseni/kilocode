import { Schema } from "effect"
import { createHash } from "node:crypto"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { preferences } from "./profile-preferences"
import { host } from "./profile-host"

const strict = { parseOptions: { onExcessProperty: "error" as const } }
const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const uuid = Schema.String.check(Schema.isUUID())
const revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const model = Schema.Struct({ providerID: identifier, modelID: identifier }).annotate(strict)
const picks = Schema.Array(model).check(Schema.isMaxLength(1000))
const variant = Schema.Union([identifier, Schema.Literal("")])
const plain = Schema.Array(
  Schema.Struct({ providerID: identifier, modelID: identifier, variant }).annotate(strict),
).check(Schema.isMaxLength(128))
const variants = Schema.Array(
  Schema.Struct({
    agent: Schema.optional(identifier),
    providerID: identifier,
    modelID: identifier,
    variant,
  }).annotate(strict),
).check(Schema.isMaxLength(128))
const agents = Schema.Array(
  Schema.Struct({ agent: identifier, providerID: identifier, modelID: identifier }).annotate(strict),
).check(Schema.isMaxLength(1000))
const models = Schema.Struct({
  selected: Schema.optional(model),
  recent: picks,
  favorite: picks,
  agents,
  variants: Schema.optional(variants),
  expanded: Schema.optional(Schema.Boolean),
}).annotate(strict)
const owner = Schema.Struct({
  selected: Schema.optional(model),
  recent: picks,
  favorite: picks,
  agents,
  variants: Schema.optional(plain),
  expanded: Schema.optional(Schema.Boolean),
}).annotate(strict)
const profile = Schema.Struct({
  format: Schema.Literal("raya.profile-preferences"),
  version: Schema.Literal(1),
  reviewOnly: Schema.Literal(true),
  activation: Schema.Literal("held"),
  config: Schema.Struct({
    model: Schema.optional(model),
    smallModel: Schema.optional(model),
    defaultAgent: Schema.optional(identifier),
  }).annotate(strict),
  modelState: Schema.Struct({
    models: agents,
    recent: picks,
    favorite: picks,
    variants: Schema.optional(plain),
  }).annotate(strict),
  extensionState: Schema.Struct({
    recentModels: picks,
    favoriteModels: picks,
    variants: Schema.optional(variants),
    expanded: Schema.optional(Schema.Boolean),
  }).annotate(strict),
}).annotate(strict)
const source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("profile"), preferences: profile }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("host"),
    id: uuid,
    role: Schema.Literals(["view", "agent-manager"]),
    revision,
    models,
    owners: Schema.Array(Schema.Struct({ id: uuid, revision, models: Schema.optional(owner) }).annotate(strict)).check(
      Schema.isMaxLength(256),
    ),
  }).annotate(strict),
])

/** Review inventory only; neither this codec nor its revision can apply choices. */
export const Choices = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), state: Schema.Literal("absent") }).annotate(strict),
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("unavailable"),
    error: Schema.Literal("Saved model choices are unavailable. Repair the saved evidence before applying choices."),
  }).annotate(strict),
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("ready"),
    revision: digest,
    sources: Schema.Array(source).check(Schema.isMaxLength(65)),
  }).annotate(strict),
])

const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const missing = (err: unknown) => err instanceof Error && "code" in err && err.code === "ENOENT"
const unique = (values: readonly string[]) => new Set(values).size === values.length
function validate(value: ReturnType<typeof host.parse>) {
  if (!unique(value.hosts.map((item) => item.id))) throw new Error("Duplicate source hosts")
  for (const item of value.hosts) {
    if (!unique(item.owners.map((owner) => owner.id))) throw new Error("Duplicate source owners")
    if (!unique(item.models.agents.map((agent) => agent.agent))) throw new Error("Duplicate host agent choices")
    for (const owner of item.owners)
      if (owner.models && !unique(owner.models.agents.map((agent) => agent.agent)))
        throw new Error("Duplicate owner agent choices")
  }
}
const same = (left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  right.isFile() &&
  !right.isSymbolicLink() &&
  right.nlink === 1

async function read(file: string) {
  const info = await lstat(file).catch((err: unknown) => {
    if (missing(err)) return undefined
    throw err
  })
  if (!info) return { file, info: undefined, bytes: undefined }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 1_048_576 ||
    key(await realpath(file)) !== key(path.resolve(file))
  )
    throw new Error("Unsafe saved choice evidence")
  await using handle = await open(file, "r")
  if (!same(info, await handle.stat())) throw new Error("Saved choices changed before read")
  const buffer = Buffer.alloc(info.size + 1)
  let offset = 0
  while (offset < buffer.length) {
    const value = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (!value.bytesRead) break
    offset += value.bytesRead
  }
  if (offset !== info.size || !same(info, await handle.stat())) throw new Error("Saved choices changed during read")
  return { file, info, bytes: buffer.subarray(0, offset) }
}

/** Fixed names under the active graph data root only; no webview-selected paths. */
export async function choices(data: string, hold: string) {
  try {
    const results = await Promise.allSettled(
      ["restore-preferences.json", "restore-host.json"].map((name) => read(path.join(data, name))),
    )
    const errors = results.flatMap((item) => (item.status === "rejected" ? [item.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Saved choice evidence could not be read")
    const rows = results.map((item) => {
      if (item.status !== "fulfilled") throw new Error("Saved choice evidence read did not settle")
      return item.value
    })
    const parse = (bytes: Buffer) =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown
    const preferred = rows[0].bytes === undefined ? undefined : preferences.parse(parse(rows[0].bytes))
    const captured = rows[1].bytes === undefined ? undefined : host.parse(parse(rows[1].bytes))
    if (captured) validate(captured)
    // Recheck both presence and identity after the complete multi-file read.
    for (const row of rows) {
      const current = await lstat(row.file).catch((err: unknown) => {
        if (missing(err)) return undefined
        throw err
      })
      if (!row.info && !current) continue
      if (
        !row.info ||
        !current ||
        !same(row.info, current) ||
        key(await realpath(row.file)) !== key(path.resolve(row.file))
      )
        throw new Error("Saved choice evidence changed")
    }
    if (!preferred && !captured) return Schema.decodeUnknownSync(Choices)({ version: 1, state: "absent" })
    const sources = [
      ...(preferred ? [{ kind: "profile", preferences: preferred }] : []),
      ...(captured?.hosts.map((item) => ({
        kind: "host",
        id: item.id,
        role: item.role,
        revision: item.revision,
        models: item.models,
        owners: item.owners.map((owner) => ({
          id: owner.id,
          revision: owner.revision,
          ...(owner.models ? { models: owner.models } : {}),
        })),
      })) ?? []),
    ]
    const revision = sha(
      JSON.stringify({
        version: 1,
        hold,
        files: rows.map((row) => ({
          name: path.basename(row.file),
          present: row.bytes !== undefined,
          ...(row.bytes ? { sha256: sha(row.bytes) } : {}),
        })),
        sources,
      }),
    )
    return Schema.decodeUnknownSync(Choices)({ version: 1, state: "ready", revision, sources })
  } catch {
    return Schema.decodeUnknownSync(Choices)({
      version: 1,
      state: "unavailable",
      error: "Saved model choices are unavailable. Repair the saved evidence before applying choices.",
    })
  }
}
