import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { memories, memory, scaffold } from "./profile-memory"
import { namespaceID } from "./profile-secondary-schema"
import { read } from "./profile-file"
import { quarantineName } from "./profile-memory-quarantine-schema"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file))
const selector = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      file: z.enum(["project.md", "environment.md", "corrections.md", "decisions.jsonl"]),
    })
    .strict(),
  z.object({ kind: z.literal("session"), name: memory.shape.sessions.element.shape.name }).strict(),
  z.object({ kind: z.literal("state") }).strict(),
  z.object({ kind: z.literal("manifest") }).strict(),
  z.object({ kind: z.literal("prior") }).strict(),
  z.object({ kind: z.literal("review") }).strict(),
  z.object({ kind: z.literal("quarantine"), name: quarantineName }).strict(),
  z.object({ kind: z.literal("quarantine-prior") }).strict(),
])
export const memoryTransform = z
  .object({
    kind: z.literal("memory-semantic"),
    namespace: z.union([z.literal("primary"), digest]),
    data: absolute,
    workspace: absolute,
    componentDigest: digest,
    selector,
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(32 * 1048576),
    digest,
    rawBytesPreserved: z.boolean(),
    activation: z.literal("inert"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const maximum = value.selector.kind === "quarantine-prior" ? 32 * 1048576 : 1048576
    if (value.bytes > maximum) ctx.addIssue({ code: "custom", message: "Memory selector byte bound exceeded" })
  })
export type MemoryComponents = Readonly<{
  memory: readonly z.output<typeof memory>[]
  secondary?: Readonly<{ namespaces: readonly Readonly<{ id: string; memory: readonly z.output<typeof memory>[] }>[] }>
}>
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex")
const sha = (input: string) => createHash("sha256").update(input).digest("hex")
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
function component(input: MemoryComponents, namespace: string, workspace: string) {
  const group =
    namespace === "primary" ? input.memory : input.secondary?.namespaces.find((item) => item.id === namespace)?.memory
  const values = group?.filter((item) => key(item.workspace) === key(workspace)) ?? []
  if (values.length !== 1) throw new Error("Memory correspondence component is absent or ambiguous")
  return memory.parse(values[0])
}
/** Pure validation proves archived inert component correspondence; it never supplies capture authority. */
export function validateMemory(raw: z.input<typeof memoryTransform>, input: MemoryComponents) {
  const entry = memoryTransform.parse(raw)
  const value = component(input, entry.namespace, entry.workspace)
  if (hash(value) !== entry.componentDigest) throw new Error("Memory correspondence component changed")
  const selected = entry.selector
  const folder = MemoryPaths.declared(value.workspace).folder
  const relative =
    selected.kind === "quarantine"
      ? selected.name
      : selected.kind === "quarantine-prior"
        ? "restore-quarantine.json"
        : selected.kind === "session"
          ? path.join("sessions", selected.name)
          : selected.kind === "text"
            ? selected.file
            : selected.kind === "review"
              ? "restore.json"
              : selected.kind === "prior"
                ? "restore-evidence.json"
                : selected.kind + ".json"
  if (key(entry.source) !== key(path.join(entry.data, "memory", folder, relative)))
    throw new Error("Memory correspondence exact physical selector differs")
  if (entry.namespace !== "primary" && namespaceID(entry.data, path.join(entry.data, "storage")) !== entry.namespace)
    throw new Error("Memory correspondence namespace identity differs")
  if (selected.kind === "quarantine") {
    const matches =
      value.quarantine?.filter(
        (item) =>
          item.name === selected.name &&
          key(item.source) === key(entry.source) &&
          key(item.workspace) === key(value.workspace) &&
          item.digest === entry.digest &&
          item.bytes === entry.bytes,
      ) ?? []
    if (matches.length !== 1 || !entry.rawBytesPreserved || sha(matches[0].text) !== entry.digest)
      throw new Error("Memory quarantine exact original bytes differ")
    return
  }
  if (selected.kind === "quarantine-prior") {
    const matches =
      value.quarantineLineage?.records.filter(
        (item) => key(item.source) === key(entry.source) && item.digest === entry.digest && item.bytes === entry.bytes,
      ) ?? []
    if (entry.rawBytesPreserved || matches.length !== 1 || key(matches[0].workspace) !== key(value.workspace))
      throw new Error("Memory quarantine current sidecar correspondence differs")
    return
  }
  const text =
    selected.kind === "session"
      ? value.sessions.find((item) => item.name === selected.name)?.text
      : selected.kind === "text"
        ? selected.file === "decisions.jsonl"
          ? value.decisions
          : value.sources[selected.file]
        : undefined
  if (text !== undefined) {
    if (!entry.rawBytesPreserved || Buffer.byteLength(text, "utf8") !== entry.bytes || sha(text) !== entry.digest)
      throw new Error("Memory exact text bytes differ")
    return
  }
  if (entry.rawBytesPreserved) throw new Error("Memory transformed records are not byte preservation")
  if (selected.kind === "review") {
    if (!value.review || entry.digest !== value.review.markerDigest)
      throw new Error("Memory current review marker differs")
    return
  }
  const records =
    value.lineage?.records.filter(
      (record) =>
        key(record.source) === key(entry.source) &&
        record.sourceDigest === entry.digest &&
        record.content.kind === selected.kind,
    ) ?? []
  if (records.length !== 1) throw new Error("Memory transformed source lineage is absent or ambiguous")
  if (
    selected.kind === "state" &&
    records[0].content.kind === "state" &&
    JSON.stringify(records[0].content.value) !== value.state
  )
    throw new Error("Memory current state projection differs")
  if (
    selected.kind === "manifest" &&
    records[0].content.kind === "manifest" &&
    key(records[0].content.value.canonical) !== key(value.workspace)
  )
    throw new Error("Memory manifest workspace differs")
}
const reader: unique symbol = Symbol("held-memory-reader")
export type MemoryReader = Readonly<{ [reader]: true }>
type Record = z.output<typeof memoryTransform>
const readers = new WeakMap<
  object,
  { token: Working; namespace: string; values: z.output<typeof memory>[]; records: Record[] }
>()
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
/** Read only the authenticated Global data mapping and actual native image records. */
export async function readMemory(token: Working, data: string): Promise<MemoryReader> {
  const image = assertWorking(token)
  const matches = [
    ...new Map(
      image.namespaces
        .filter((item) => key(item.original.data) === key(data))
        .map((item) => [key(item.staged.data), item]),
    ).values(),
  ]
  if (matches.length !== 1) throw new Error("Memory reader lacks one authenticated Global data scope")
  const namespace =
    key(matches[0].staged.data) === key(image.profile.data) ? "primary" : namespaceID(data, path.join(data, "storage"))
  const staged = lookup(token, data)
  const values = await memories(path.join(staged, "memory"), path.join(data, "memory"))
  const native = inventory(token)
  const records: Record[] = []
  for (const value of values) {
    const id = MemoryPaths.declared(value.workspace)
    const source = path.join(data, "memory", id.folder)
    const dir = path.join(staged, "memory", id.folder)
    const allowed = new Set([
      "project.md",
      "environment.md",
      "corrections.md",
      "decisions.jsonl",
      "state.json",
      "manifest.json",
      "sessions",
      "index.kmem",
      ".gitignore",
      "restore-evidence.json",
      "restore.json",
      ...(value.quarantineLineage ? ["restore-quarantine.json"] : []),
      ...new Set(
        (value.quarantine ?? [])
          .filter(
            (item) =>
              key(item.source) === key(path.join(source, item.name)) && key(item.workspace) === key(value.workspace),
          )
          .map((item) => item.name),
      ),
    ])
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".raya-profile-locks", ".lock"].includes(entry.name)) {
        await scaffold(path.join(dir, entry.name), path.join(source, entry.name))
        continue
      }
      if (!allowed.has(entry.name) || entry.isSymbolicLink() || (entry.isDirectory() && entry.name !== "sessions"))
        throw new Error("Memory namespace has unsupported entries")
    }
    const entries: { selector: z.output<typeof selector>; file: string }[] = [
      ...(["project.md", "environment.md", "corrections.md", "decisions.jsonl"] as const).map((file) => ({
        selector: { kind: "text" as const, file },
        file,
      })),
      ...value.sessions.map((item) => ({
        selector: { kind: "session" as const, name: item.name },
        file: path.join("sessions", item.name),
      })),
      { selector: { kind: "state" }, file: "state.json" },
      { selector: { kind: "manifest" }, file: "manifest.json" },
      { selector: { kind: "prior" }, file: "restore-evidence.json" },
      ...(value.review ? [{ selector: { kind: "review" as const }, file: "restore.json" }] : []),
      ...[
        ...new Set(
          (value.quarantine ?? [])
            .filter(
              (item) =>
                key(item.source) === key(path.join(source, item.name)) && key(item.workspace) === key(value.workspace),
            )
            .map((item) => item.name),
        ),
      ].map((name) => ({ selector: { kind: "quarantine" as const, name }, file: name })),
      ...(value.quarantineLineage
        ? [{ selector: { kind: "quarantine-prior" as const }, file: "restore-quarantine.json" }]
        : []),
    ]
    if (value.review) {
      const hold = path.join(data, "storage/raya/restore-hold.json")
      const found = native.files.filter((record) => key(record.path) === key(hold))
      const bytes = await read(path.join(staged, "storage/raya/restore-hold.json"), 65536, 65536)
      if (
        found.length !== 1 ||
        found[0].bytes !== bytes.bytes ||
        found[0].digest !== sha(bytes.value) ||
        value.review.receiptDigest !== found[0].digest
      )
        throw new Error("Memory review lacks exact held destination receipt")
    }
    for (const entry of entries) {
      const file = path.join(source, entry.file)
      const found = native.files.filter((record) => key(record.path) === key(file))
      if (!found.length && (entry.file === "decisions.jsonl" || entry.file === "restore-evidence.json")) continue
      if (found.length !== 1) throw new Error("Memory reader lacks exact native file identity")
      const maximum = entry.selector.kind === "quarantine-prior" ? 32 * 1048576 : 1048576
      const bytes = await read(path.join(dir, entry.file), maximum, maximum)
      if (bytes.bytes !== found[0].bytes || sha(bytes.value) !== found[0].digest)
        throw new Error("Memory staged UTF8 bytes differ from native source")
      const candidate = memoryTransform.parse({
        kind: "memory-semantic",
        namespace,
        data,
        workspace: value.workspace,
        componentDigest: hash(value),
        selector: entry.selector,
        source: file,
        dev: found[0].dev,
        ino: found[0].ino,
        bytes: found[0].bytes,
        digest: found[0].digest,
        rawBytesPreserved:
          entry.selector.kind === "text" || entry.selector.kind === "session" || entry.selector.kind === "quarantine",
        activation: "inert",
      })
      // Lossy states and merged decision strings remain explicitly unclassified in selected exports.
      const accepted = (() => {
        try {
          validateMemory(candidate, {
            memory: namespace === "primary" ? values : [],
            secondary: { namespaces: [{ id: namespace, memory: values }] },
          })
          return true
        } catch (err) {
          if (
            err instanceof Error &&
            /^Memory (current state projection differs|transformed source lineage is absent or ambiguous|exact text bytes differ)$/.test(
              err.message,
            )
          )
            return false
          throw err
        }
      })()
      if (accepted) records.push(candidate)
      if (records.length > 20000) throw new Error("Memory correspondence exceeds inventory bound")
    }
  }
  inventory(token)
  const proof = Object.freeze({ [reader]: true as const })
  readers.set(proof, { token, namespace, values: freeze(values), records: freeze(records) })
  return proof
}
export function memoryValues(token: Working, proof: MemoryReader) {
  inventory(token)
  const state = readers.get(proof)
  if (!state || state.token !== token) throw new Error("Memory reader is absent or belongs to another image")
  return state.values
}
const brand: unique symbol = Symbol("held-memory-correspondence")
export type MemoryClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; records: readonly Record[] }>()
export function bindMemory(token: Working, proofs: readonly MemoryReader[], input: MemoryComponents): MemoryClaim {
  inventory(token)
  const records: Record[] = []
  const seen = new Set<string>()
  for (const proof of proofs) {
    memoryValues(token, proof)
    const state = readers.get(proof)!
    for (const value of state.values)
      if (hash(component(input, state.namespace, value.workspace)) !== hash(value))
        throw new Error("Memory component differs from actual held reader")
    for (const entry of state.records) {
      if (seen.has(key(entry.source))) throw new Error("Duplicate memory correspondence source")
      seen.add(key(entry.source))
      validateMemory(entry, input)
      records.push(entry)
    }
  }
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, records: freeze(records) })
  return claim
}
export function memoryGroups(token: Working, claim: MemoryClaim) {
  inventory(token)
  const value = claims.get(claim)
  if (!value || value.token !== token) throw new Error("Memory claim is absent or belongs to another image")
  return value.records
}
