import { createHash } from "node:crypto"
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { z } from "zod"
import * as Data from "../self-heal/schemas"
import { assertWorking, lookup, type Working } from "./profile-image"
import { identity } from "./profile-workspaces"
import { checkouts, collectCheckout, restoreCheckouts } from "./profile-checkouts"

const sum = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const relative = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => !value.includes("\\") && value.split("/").every((part) => /^[A-Za-z0-9_-]+(?:\.json)?$/.test(part)),
  )
const time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const text = Schema.String
const stage = {
  intake: Schema.Struct({ id: text, baseline: Schema.Number }),
  report: Schema.Struct({ at: time }),
  intent: Schema.Struct({
    id: text,
    itemID: text,
    attemptID: text,
    sessionID: text,
    messageID: text,
    callID: text,
    input: Data.Verifications.Input,
    at: time,
  }),
  snapshot: Schema.Struct({ digest: text, head: text, directory: text, at: time }),
  preparation: Schema.Struct({ at: time, command: text }),
  dispatch: Schema.Struct({ at: time, command: text, directory: text }),
  terminal: Schema.Union([
    Schema.Struct({ status: Schema.Literal("failed"), at: time, exit: Schema.optional(Schema.Number) }),
    Schema.Struct({ status: Schema.Literals(["failed", "interrupted"]), at: time, reason: text }),
  ]),
  artifactIntent: Schema.Struct({ id: text, itemID: text, attemptID: text, setup: text, at: time }),
  artifactPreparation: Schema.Struct({ command: text, directory: text, at: time }),
  artifactDispatch: Schema.Struct({ at: time, command: text }),
}
function contract(file: string) {
  const parts = relative
    .parse(file)
    .replace(/\.json$/, "")
    .split("/")
  const [kind, id, leaf] = parts
  if (parts.length === 2 && ["item", "seed"].includes(kind)) return { kind, schema: Data.Backlogs.Item }
  if (parts.length === 2 && kind === "closed") return { kind, schema: Schema.Literal(true) }
  if (parts.length === 2 && kind === "completion") return { kind, schema: Data.Completions.Completion }
  if (parts.length === 2 && kind === "artifact-item") return { kind, schema: Data.Artifacts.Pointer }
  if (parts.length === 2 && kind === "artifact-approval") return { kind, schema: Data.Artifacts.Approval }
  if (parts.length === 3 && kind === "reports" && (leaf === "base" || z.string().uuid().safeParse(leaf).success))
    return { kind, schema: leaf === "base" ? Schema.Number : stage.report }
  if (parts.length === 3 && kind === "intake" && /^[a-f0-9]{64}$/.test(id)) return { kind, schema: stage.intake }
  if (parts.length === 3 && kind === "repair" && /^[a-f0-9]{64}$/.test(id) && /^(?:[0-9]|1[0-2])$/.test(leaf))
    return { kind, schema: Data.Repairs.Claim }
  if (parts.length === 3 && kind === "publication" && /^[a-f0-9]{64}$/.test(id) && /^[a-f0-9]{64}$/.test(leaf))
    return { kind, schema: Data.Publications.Receipt }
  if (parts.length === 3 && ["verification", "artifact"].includes(kind) && /^[a-f0-9]{64}$/.test(id)) {
    const schemas =
      kind === "verification"
        ? {
            intent: stage.intent,
            snapshot: stage.snapshot,
            preparation: stage.preparation,
            dispatch: stage.dispatch,
            terminal: stage.terminal,
            result: Data.Verifications.Receipt,
          }
        : {
            intent: stage.artifactIntent,
            build: Data.BuildInputs.Build,
            preparation: stage.artifactPreparation,
            dispatch: stage.artifactDispatch,
            terminal: Data.Artifacts.Terminal,
            result: Data.Artifacts.Receipt,
          }
    const schema = Object.entries(schemas).find(([name]) => name === leaf)?.[1]
    if (schema) return { kind, schema }
  }
  throw new Error("Unknown self-heal history entry")
}
const decode = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
function validate(file: string, value: unknown, archived = false) {
  const found = contract(file)
  const result =
    found.kind === "repair"
      ? archived
        ? decode(Data.Repairs.Outcome, value)
        : decode(Data.Repairs.Claim, value).outcome
      : decode(found.schema, value)
  const parts = file.replace(/\.json$/, "").split("/")
  if (found.kind === "repair") {
    const outcome = decode(Data.Repairs.Outcome, result)
    if (sum(outcome.itemID) !== parts[1] || outcome.revision !== Number(parts[2]))
      throw new Error("Self-heal repair record identity differs from its journal")
    if (!archived) hash.parse(decode(Data.Repairs.Claim, value).owner)
  }
  if (["item", "seed"].includes(found.kind) && decode(Data.Backlogs.Item, result).id !== parts[1])
    throw new Error("Self-heal report identity differs from its journal")
  if (found.kind === "completion" && sum(decode(Data.Completions.Completion, result).itemID) !== parts[1])
    throw new Error("Self-heal completion identity differs from its journal")
  if (found.kind === "artifact-item" && decode(Data.Artifacts.Pointer, result).itemID !== parts[1])
    throw new Error("Self-heal artifact pointer identity differs from its journal")
  if (found.kind === "artifact-approval" && decode(Data.Artifacts.Approval, result).itemID !== parts[1])
    throw new Error("Self-heal approval identity differs from its journal")
  if (found.kind === "publication") {
    const receipt = decode(Data.Publications.Receipt, result)
    if (
      sum(receipt.itemID) !== parts[1] ||
      sum(JSON.stringify([receipt.installationID, receipt.goalRevision])) !== parts[2]
    )
      throw new Error("Self-heal publication identity differs from its journal")
  }
  if (found.kind === "verification" && ["intent", "result"].includes(parts[2])) {
    const receipt = parts[2] === "intent" ? decode(stage.intent, result) : decode(Data.Verifications.Receipt, result)
    if (sum(JSON.stringify([receipt.sessionID, receipt.messageID, receipt.callID])) !== parts[1])
      throw new Error("Self-heal verification identity differs from its journal")
  }
  if (found.kind === "artifact" && parts[2] === "result") {
    const receipt = decode(Data.Artifacts.Receipt, result)
    if (sum(JSON.stringify([receipt.sessionID, receipt.messageID, receipt.callID])) !== parts[1])
      throw new Error("Self-heal artifact identity differs from its journal")
  }
  return result
}
const record = z
  .object({
    root: absolute,
    path: relative,
    source: hash,
    digest: hash,
    text: z.string().max(1_048_576),
    excluded: z.array(z.literal("repair-owner")).max(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      if (Buffer.byteLength(value.text) > 1_048_576 || sum(value.text) !== value.digest)
        throw new Error("Invalid bytes")
      validate(value.path, JSON.parse(value.text), true)
      const repair = value.path.startsWith("repair/")
      if (repair !== (value.excluded.length === 1)) throw new Error("Invalid exclusion")
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid inactive self-heal history" })
    }
  })
const records = z.array(record).max(10_000)
const sidecar = z
  .object({
    original: absolute,
    kind: z.enum(["snapshot-blob", "snapshot-manifest", "artifact"]),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    digest: hash,
    data: z.string().max(90 * 1024 * 1024),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const bytes = Buffer.from(value.data, "base64")
      if (bytes.toString("base64") !== value.data || bytes.length !== value.bytes || sum(bytes) !== value.digest)
        throw new Error("Invalid sidecar bytes")
      if (value.kind === "snapshot-blob" && path.basename(value.original) !== value.digest)
        throw new Error("Invalid snapshot blob name")
      if (value.kind === "snapshot-manifest") {
        const snapshot = decode(
          Data.Snapshots.Snapshot,
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        )
        if (
          sum(JSON.stringify(snapshot)) !== path.basename(value.original) ||
          sum(JSON.stringify({ head: snapshot.head, files: snapshot.files })) !== snapshot.digest
        )
          throw new Error("Invalid snapshot manifest")
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid self-heal sidecar" })
    }
  })
const lineage = z.object({ records, files: z.array(sidecar).max(10_000), checkouts: checkouts.optional() }).strict()
export const selfHeal = lineage
  .extend({ version: z.literal(1), history: z.array(lineage).max(32) })
  .strict()
  .superRefine((value, ctx) => {
    let bytes = 0
    for (const entry of [value, ...value.history]) {
      const entries = entry.records
      const seen = new Set<string>()
      for (const item of entries) {
        bytes += Buffer.byteLength(item.text)
        const key = `${identity(item.root)}:${item.path}`
        if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate self-heal record" })
        seen.add(key)
      }
      const files = new Set<string>()
      for (const item of entry.files) {
        bytes += item.bytes
        if (files.has(identity(item.original))) ctx.addIssue({ code: "custom", message: "Duplicate self-heal sidecar" })
        files.add(identity(item.original))
      }
      const records = new Set(entry.records.map((item) => `${item.root}:${item.path}`))
      const refs = (() => {
        try {
          return requirements({ ...entry, version: 1, history: [] })
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid verification checkout history binding" })
          return []
        }
      })()
      for (const row of entry.checkouts ?? []) {
        bytes += row.files.reduce((sum, file) => sum + file.bytes, 0)
        if (row.sources.some((source) => !records.has(source)))
          ctx.addIssue({ code: "custom", message: "Verification checkout lacks exact history binding" })
        for (const source of row.sources) {
          const matches = refs.filter(
            (item) =>
              item.kind === "verification-checkout" &&
              item.sourceRecord === source &&
              identity(item.path) === identity(row.original),
          )
          if (
            !matches.length ||
            matches.some((item) => (item.snapshot?.digest ?? item.digest) !== row.snapshot?.digest)
          )
            ctx.addIssue({ code: "custom", message: "Verification checkout snapshot differs from exact journal" })
        }
      }
    }
    if (bytes > 96 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Self-heal history exceeds supported bytes" })
  })
async function present(file: string) {
  return lstat(file).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
}
async function bytes(file: string, limit = 1_048_576) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
    throw new Error("Unsupported self-heal history file")
  const fd = await open(file, "r")
  try {
    const current = await fd.stat()
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.nlink !== 1)
      throw new Error("Self-heal file changed during admission")
    const bytes = Buffer.alloc(current.size)
    if ((await fd.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length)
      throw new Error("Incomplete self-heal history")
    const after = await fd.stat()
    if (after.size !== current.size || after.mtimeMs !== current.mtimeMs)
      throw new Error("Self-heal file changed during read")
    return bytes
  } finally {
    await fd.close()
  }
}
const read = async (file: string, limit = 1_048_576) =>
  new TextDecoder("utf-8", { fatal: true }).decode(await bytes(file, limit))
type Scope = Readonly<{ data: string; storage: string }>
/** Inert provenance only: no stored claim, completion or approval becomes destination authority. */
async function scan(token: Working, globals: readonly Scope[]) {
  const scope = assertWorking(token)
  const mapped = (file: string) => {
    const found = scope.original
      .filter(
        (entry) =>
          entry.kind === "json" &&
          (identity(file) === identity(entry.path) || identity(file).startsWith(identity(entry.path + path.sep))),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!found) throw new Error("Self-heal scope lacks authenticated held mapping")
    return path.join(lookup(token, found.path), path.relative(found.path, file))
  }
  const retained: z.infer<typeof records> = []
  const history: z.infer<typeof lineage>[] = []
  const budget = { bytes: 0 }
  const roots = [
    ...new Map(globals.map((entry) => [`${identity(entry.data)}:${identity(entry.storage)}`, entry])).values(),
  ]
  const storages = new Set<string>()
  const archives = new Set<string>()
  for (const entry of roots) {
    const root = absolute.parse(entry.storage)
    const base = mapped(path.join(root, "raya", "self-heal"))
    const walk = async (directory: string, prefix: string, depth: number) => {
      assertWorking(token)
      const stat = await present(directory)
      if (!stat) return
      if (!stat.isDirectory() || stat.isSymbolicLink() || depth > 3)
        throw new Error("Unsupported self-heal history directory")
      const entries = await readdir(directory, { withFileTypes: true })
      if (entries.length > 10_000) throw new Error("Self-heal history exceeds entry count")
      for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = `${prefix}${item.name}`
        if (item.isSymbolicLink()) throw new Error("Aliased self-heal history entry")
        if (item.isDirectory()) {
          await walk(path.join(directory, item.name), `${file}/`, depth + 1)
          continue
        }
        if (!item.isFile() || !item.name.endsWith(".json")) throw new Error("Unknown nonempty self-heal history entry")
        contract(file)
        const raw = await read(path.join(directory, item.name))
        const value = validate(file, JSON.parse(raw))
        const text = JSON.stringify(value)
        budget.bytes += Buffer.byteLength(text)
        if (retained.length >= 10_000 || budget.bytes > 32 * 1024 * 1024)
          throw new Error("Self-heal history exceeds supported size")
        retained.push(
          record.parse({
            root,
            path: file,
            source: sum(raw),
            digest: sum(text),
            text,
            excluded: file.startsWith("repair/") ? ["repair-owner"] : [],
          }),
        )
      }
    }
    if (!storages.has(identity(root))) await walk(base, "", 0)
    storages.add(identity(root))
    const old = mapped(path.join(absolute.parse(entry.data), "restore-self-heal.json"))
    if (!archives.has(identity(entry.data)) && (await present(old))) {
      const prior = selfHeal.parse(JSON.parse(await read(old, 140 * 1024 * 1024)))
      history.push(...prior.history, {
        records: prior.records,
        files: prior.files,
        ...(prior.checkouts ? { checkouts: prior.checkouts } : {}),
      })
    }
    archives.add(identity(entry.data))
  }
  assertWorking(token)
  return selfHeal.parse({ version: 1, records: retained, files: [], history })
}
export async function restoreSelfHeal(raw: unknown, data: string) {
  const value = selfHeal.parse(raw)
  await mkdir(data, { recursive: true })
  const directory = path.join(data, "restore-self-heal-files")
  const stored = new Set<string>()
  for (const scope of [value, ...value.history]) {
    for (const file of scope.files) {
      if (stored.has(file.digest)) continue
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, file.digest), Buffer.from(file.data, "base64"), { flag: "wx" })
      stored.add(file.digest)
    }
  }
  const retained = [
    ...new Map(
      [value, ...value.history]
        .flatMap((scope) => scope.checkouts ?? [])
        .map((row) => [row.original + "\0" + row.digest, row]),
    ).values(),
  ]
  await restoreCheckouts(retained, data)
  await writeFile(path.join(data, "restore-self-heal.json"), JSON.stringify(value), { flag: "wx" })
}

/** These paths come from shipped typed records, never from arbitrary strings in evidence or commands. */
export async function planSelfHeal(token: Working, globals: readonly Scope[]) {
  const value = await scan(token, globals)
  const required = await namespaces(token, globals, value)
  return Object.freeze({
    fingerprint: sum(JSON.stringify({ records: value.records, history: value.history, requirements: required })),
    records: value.records,
    requirements: Object.freeze(required.map((item) => Object.freeze(item))),
  })
}
function requirements(value: z.infer<typeof selfHeal>) {
  const requirements: {
    kind: "repair-worktree" | "source-repository" | "verification-checkout" | "verification-store" | "artifact"
    path: string
    sourceRecord: string
    snapshot?: typeof Data.Snapshots.Snapshot.Type
    digest?: string
    bytes?: number
  }[] = []
  for (const item of value.records) {
    const raw = JSON.parse(item.text)
    const parts = item.path.replace(/\.json$/, "").split("/")
    const sourceRecord = `${item.root}:${item.path}`
    const repair = (outcome: typeof Data.Repairs.Outcome.Type) => {
      requirements.push({ kind: "source-repository", path: absolute.parse(outcome.source.root), sourceRecord })
      if (outcome.worktree)
        requirements.push({ kind: "repair-worktree", path: absolute.parse(outcome.worktree.directory), sourceRecord })
    }
    const snapshot = (directory: string, input: typeof Data.Snapshots.Snapshot.Type) => {
      absolute.parse(directory)
      if (path.basename(path.dirname(directory)) !== "runs")
        throw new Error("Unsupported self-heal verification store lineage")
      requirements.push({ kind: "verification-checkout", path: directory, sourceRecord, snapshot: input })
      requirements.push({
        kind: "verification-store",
        path: path.dirname(path.dirname(directory)),
        sourceRecord,
        snapshot: input,
      })
    }
    if (["item", "seed"].includes(parts[0])) {
      const input = decode(Data.Backlogs.Item, raw)
      if (input.repair) repair(input.repair)
      if (input.completion) {
        requirements.push({
          kind: "source-repository",
          path: absolute.parse(input.completion.source.root),
          sourceRecord,
        })
        requirements.push({
          kind: "repair-worktree",
          path: absolute.parse(input.completion.worktree.directory),
          sourceRecord,
        })
      }
    }
    if (parts[0] === "repair") repair(decode(Data.Repairs.Outcome, raw))
    if (parts[0] === "completion") {
      const input = decode(Data.Completions.Completion, raw)
      requirements.push({ kind: "source-repository", path: absolute.parse(input.source.root), sourceRecord })
      requirements.push({ kind: "repair-worktree", path: absolute.parse(input.worktree.directory), sourceRecord })
    }
    if (parts[0] === "verification" && parts[2] === "result") {
      const input = decode(Data.Verifications.Receipt, raw)
      snapshot(input.directory, input.snapshot)
    }
    if (parts[0] === "verification" && parts[2] === "snapshot") {
      const input = decode(stage.snapshot, raw)
      if (path.basename(path.dirname(absolute.parse(input.directory))) !== "runs")
        throw new Error("Unsupported interrupted verification store lineage")
      requirements.push({
        kind: "verification-checkout",
        path: input.directory,
        sourceRecord,
        digest: hash.parse(input.digest),
      })
      requirements.push({
        kind: "verification-store",
        path: path.dirname(path.dirname(input.directory)),
        sourceRecord,
        digest: hash.parse(input.digest),
      })
    }
    if (parts[0] === "artifact" && parts[2] === "build") {
      const input = decode(Data.BuildInputs.Build, raw)
      snapshot(input.directory, input.snapshot)
    }
    if (parts[0] === "artifact" && parts[2] === "result") {
      const input = decode(Data.Artifacts.Receipt, raw)
      requirements.push({
        kind: "artifact",
        path: absolute.parse(input.output),
        sourceRecord,
        digest: input.artifact.digest,
        bytes: input.artifact.size,
      })
    }
  }
  return requirements
}

async function namespaces(token: Working, globals: readonly Scope[], value: z.infer<typeof selfHeal>) {
  const found = requirements(value)
  const scope = assertWorking(token)
  for (const item of globals) {
    const directory = path.join(absolute.parse(item.data), "raya", "verification")
    const root = scope.original
      .filter(
        (entry) =>
          entry.kind === "json" &&
          (identity(directory) === identity(entry.path) ||
            identity(directory).startsWith(identity(entry.path + path.sep))),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!root) throw new Error("Self-heal data scope lacks held namespace")
    const staged = path.join(lookup(token, root.path), path.relative(root.path, directory))
    if (await present(staged))
      found.push({ kind: "verification-store", path: directory, sourceRecord: `${item.data}:raya/verification` })
  }
  assertWorking(token)
  return found
}

/** Read only typed snapshot stores and artifact bytes from the final held image. */
export async function collectSelfHeal(token: Working, globals: readonly Scope[]) {
  const value = await scan(token, globals)
  const scope = assertWorking(token)
  const files: z.infer<typeof sidecar>[] = []
  const seen = new Set<string>()
  const indexed = new Map<string, z.infer<typeof sidecar>>()
  const stores = new Set<string>()
  const manifests = new Map<string, typeof Data.Snapshots.Snapshot.Type>()
  const budget = { bytes: Buffer.byteLength(JSON.stringify(value)) }
  const mapped = (file: string) => {
    const found = scope.original
      .filter(
        (entry) =>
          entry.kind === "json" &&
          (identity(file) === identity(entry.path) || identity(file).startsWith(identity(entry.path + path.sep))),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!found) throw new Error("Self-heal sidecar lacks held mapping")
    return path.join(lookup(token, found.path), path.relative(found.path, file))
  }
  const retain = async (
    original: string,
    kind: z.infer<typeof sidecar>["kind"],
    expected?: { digest: string; bytes: number },
  ) => {
    if (seen.has(identity(original))) return
    assertWorking(token)
    const data = await bytes(mapped(original), 64 * 1024 * 1024)
    budget.bytes += data.length
    if (files.length >= 10_000 || budget.bytes > 96 * 1024 * 1024)
      throw new Error("Self-heal sidecars exceed supported bytes")
    const digest = sum(data)
    if (expected && (digest !== expected.digest || data.length !== expected.bytes))
      throw new Error("Self-heal artifact bytes disagree with retained receipt")
    const retained = sidecar.parse({ original, kind, bytes: data.length, digest, data: data.toString("base64") })
    files.push(retained)
    indexed.set(identity(original), retained)
    if (kind === "snapshot-manifest") {
      const snapshot = decode(Data.Snapshots.Snapshot, JSON.parse(data.toString("utf8")))
      manifests.set(`${identity(path.dirname(path.dirname(original)))}:${snapshot.digest}`, snapshot)
    }
    seen.add(identity(original))
  }
  const required = await namespaces(token, globals, value)
  for (const item of required) {
    if (item.kind === "artifact") {
      if (!item.digest || item.bytes === undefined) throw new Error("Self-heal artifact lacks byte identity")
      await retain(item.path, "artifact", { digest: item.digest, bytes: item.bytes })
      continue
    }
    if (item.kind !== "verification-store") continue
    if (!stores.has(identity(item.path))) {
      const base = mapped(item.path)
      const entries = await readdir(base, { withFileTypes: true })
      if (
        entries.length > 3 ||
        entries.some(
          (entry) =>
            entry.isSymbolicLink() || !entry.isDirectory() || !["blobs", "manifests", "runs"].includes(entry.name),
        )
      )
        throw new Error("Unknown nonempty self-heal verification store entry")
      for (const directory of ["blobs", "manifests"] as const) {
        const source = path.join(item.path, directory)
        const root = mapped(source)
        if (!(await present(root))) continue
        const entries = await readdir(root, { withFileTypes: true })
        if (
          entries.length > 10_000 ||
          entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !hash.safeParse(entry.name).success)
        )
          throw new Error("Unknown self-heal snapshot sidecar")
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
          await retain(path.join(source, entry.name), directory === "blobs" ? "snapshot-blob" : "snapshot-manifest")
      }
      stores.add(identity(item.path))
    }
    const snapshot =
      item.snapshot ??
      (item.digest
        ? (() => {
            const found = manifests.get(`${identity(item.path)}:${item.digest}`)
            if (!found) throw new Error("Interrupted verification lacks retained snapshot manifest")
            return found
          })()
        : undefined)
    if (snapshot) {
      for (const entry of snapshot.files) {
        const blob = indexed.get(identity(path.join(item.path, "blobs", entry.digest)))
        if (!blob || blob.bytes !== entry.size) throw new Error("Self-heal snapshot lacks retained source bytes")
      }
      const manifest = indexed.get(identity(path.join(item.path, "manifests", sum(JSON.stringify(snapshot)))))
      if (!manifest) throw new Error("Self-heal snapshot lacks retained manifest")
    }
  }
  const retained: z.infer<typeof checkouts> = []
  for (const store of stores) {
    const original = required.find((item) => item.kind === "verification-store" && identity(item.path) === store)?.path
    if (!original) throw new Error("Verification checkout lacks exact store identity")
    const runs = path.join(original, "runs")
    if (!(await present(mapped(runs)))) continue
    const entries = await readdir(mapped(runs), { withFileTypes: true })
    if (entries.length > 1000) throw new Error("Verification checkout count exceeds supported limit")
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !z.string().uuid().safeParse(entry.name).success)
        throw new Error("Unknown nonempty verification checkout entry")
      const directory = path.join(runs, entry.name)
      const refs = required.filter(
        (item) => item.kind === "verification-checkout" && identity(item.path) === identity(directory),
      )
      const snapshots = refs.flatMap((item) => (item.snapshot ? [item.snapshot] : []))
      for (const item of value.records) {
        if (
          !refs.some((ref) => ref.sourceRecord === `${item.root}:${item.path}`) ||
          !item.path.endsWith("/snapshot.json")
        )
          continue
        const saved = decode(stage.snapshot, JSON.parse(item.text))
        const snapshot = manifests.get(`${identity(original)}:${saved.digest}`)
        if (!snapshot) throw new Error("Verification checkout lacks retained snapshot")
        snapshots.push(snapshot)
      }
      const distinct = [...new Map(snapshots.map((snapshot) => [snapshot.digest, snapshot])).values()]
      if (distinct.length > 1) throw new Error("Verification checkout has conflicting snapshot identities")
      retained.push(
        await collectCheckout(
          token,
          directory,
          refs.map((ref) => ref.sourceRecord),
          distinct[0],
        ),
      )
    }
  }
  assertWorking(token)
  return selfHeal.parse({ ...value, files, ...(retained.length ? { checkouts: retained } : {}) })
}
