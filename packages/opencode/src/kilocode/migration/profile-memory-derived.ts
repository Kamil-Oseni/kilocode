import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { MemorySchema } from "@kilocode/kilo-memory/schema"
import { MemoryIndexer } from "../../../../kilo-memory/src/recall/indexer"
import { MemoryMarkdown } from "../../../../kilo-memory/src/storage/markdown"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { read } from "./profile-file"
import { memory } from "./profile-memory"
import { readMemory, memoryValues, type MemoryComponents } from "./profile-memory-correspondence"
import { memoryState } from "./profile-memory-lineage"
import { namespaceID } from "./profile-secondary-schema"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file))
const input = z
  .object({
    file: z.string().max(512),
    digest,
    bytes: z.number().int().safe().nonnegative().max(1048576),
    modified: z.number().safe().nonnegative(),
    ticks: z
      .string()
      .max(20)
      .regex(/^\d+$/)
      .refine((value) => /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n)
      .optional(),
  })
  .strict()
export const memoryDerived = z
  .object({
    kind: z.literal("memory-derived"),
    namespace: z.union([z.literal("primary"), digest]),
    data: absolute,
    workspace: absolute,
    componentDigest: digest,
    selector: z.enum(["index", "ignore"]),
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z.number().int().safe().nonnegative().max(1048576),
    digest,
    renderer: z.enum(["MemoryIndexer.build", "MemoryState.scaffold"]),
    inputs: z.array(input).max(4096),
    rendererDigest: digest,
    evidenceDigest: digest,
    sourceTimestampAuthority: z.literal(false),
    activation: z.literal("inert"),
  })
  .strict()
type Entry = z.output<typeof memoryDerived>
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
const ignore = "*\n!.gitignore\n"
function component(values: MemoryComponents, namespace: string, workspace: string) {
  const group =
    namespace === "primary" ? values.memory : values.secondary?.namespaces.find((item) => item.id === namespace)?.memory
  const matches = group?.filter((item) => key(item.workspace) === key(workspace)) ?? []
  if (matches.length !== 1) throw new Error("Derived memory component is absent or ambiguous")
  return memory.parse(matches[0])
}
function texts(value: z.output<typeof memory>) {
  return new Map([
    ["state.json", value.state],
    ...Object.entries(value.sources),
    ...value.sessions.map((item) => [path.posix.join("sessions", item.name), item.text] as const),
  ])
}
/** Historical renderer evidence is inert; only the live opaque binder proves actual execution. */
export function validateMemoryDerived(raw: z.input<typeof memoryDerived>, values: MemoryComponents) {
  const entry = memoryDerived.parse(raw)
  const value = component(values, entry.namespace, entry.workspace)
  if (hash(value) !== entry.componentDigest) throw new Error("Derived memory component changed")
  if (entry.namespace !== "primary" && namespaceID(entry.data, path.join(entry.data, "storage")) !== entry.namespace)
    throw new Error("Derived memory namespace differs")
  const source = path.join(
    entry.data,
    "memory",
    MemoryPaths.declared(value.workspace).folder,
    entry.selector === "index" ? "index.kmem" : ".gitignore",
  )
  if (key(source) !== key(entry.source)) throw new Error("Derived memory physical selector differs")
  const evidence = {
    componentDigest: entry.componentDigest,
    selector: entry.selector,
    renderer: entry.renderer,
    inputs: entry.inputs,
    rendererDigest: entry.rendererDigest,
  }
  if (hash(evidence) !== entry.evidenceDigest || entry.digest !== entry.rendererDigest)
    throw new Error("Derived memory renderer evidence changed")
  if (entry.selector === "ignore") {
    if (
      entry.renderer !== "MemoryState.scaffold" ||
      entry.inputs.length ||
      entry.digest !== sha(ignore) ||
      entry.bytes !== Buffer.byteLength(ignore)
    )
      throw new Error("Derived memory scaffold differs")
    return
  }
  if (entry.renderer !== "MemoryIndexer.build") throw new Error("Derived memory renderer differs")
  const selected = texts(value)
  if (entry.inputs.length !== selected.size || new Set(entry.inputs.map((item) => item.file)).size !== selected.size)
    throw new Error("Derived memory renderer inputs differ")
  for (const item of entry.inputs) {
    const text = selected.get(item.file)
    if (item.file === "state.json") {
      const records =
        value.lineage?.records.filter(
          (record) =>
            key(record.source) === key(path.join(path.dirname(entry.source), "state.json")) &&
            record.sourceDigest === item.digest &&
            record.content.kind === "state",
        ) ?? []
      if (
        records.length !== 1 ||
        records[0].content.kind !== "state" ||
        JSON.stringify({
          ...MemorySchema.persist(MemorySchema.parse(records[0].content.value)),
          autoInject: records[0].content.value.autoInject,
        }) !== text
      )
        throw new Error("Derived memory renderer state lineage differs")
      continue
    }
    if (text === undefined || sha(text) !== item.digest || Buffer.byteLength(text) !== item.bytes)
      throw new Error("Derived memory renderer input bytes differ")
  }
}
const brand: unique symbol = Symbol("held-memory-derived")
export type MemoryDerivedClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; entries: readonly Entry[] }>()
/** Render only verified immutable image bytes; no original source reads or scratch publication. */
export async function bindMemoryDerived(token: Working, values: MemoryComponents): Promise<MemoryDerivedClaim> {
  inventory(token)
  const snapshot = structuredClone(values)
  const entries: Entry[] = []
  const groups = [
    { namespace: "primary", values: snapshot.memory },
    ...(snapshot.secondary?.namespaces.map((item) => ({ namespace: item.id, values: item.memory })) ?? []),
  ]
  for (const group of groups) {
    if (!group.values.length) continue
    const native = inventory(token)
    const image = assertWorking(token)
    const candidates = image.namespaces.filter((item) =>
      group.namespace === "primary"
        ? key(item.staged.data) === key(image.profile.data)
        : namespaceID(item.original.data, path.join(item.original.data, "storage")) === group.namespace,
    )
    const roots = [...new Map(candidates.map((item) => [key(item.original.data), item.original.data])).values()]
    if (roots.length !== 1) throw new Error("Derived memory lacks one exact held data namespace")
    const data = roots[0]
    const reader = await readMemory(token, data)
    if (hash(memoryValues(token, reader)) !== hash(group.values))
      throw new Error("Derived memory differs from actual held reader")
    const staged = lookup(token, data)
    for (const value of group.values) {
      const folder = MemoryPaths.declared(value.workspace).folder
      const source = path.join(data, "memory", folder)
      const dir = path.join(staged, "memory", folder)
      const inputs: z.output<typeof input>[] = []
      const eligible = { index: true }
      for (const [file, text] of texts(value)) {
        const found = native.files.filter((item) => key(item.path) === key(path.join(source, file)))
        if (found.length !== 1) throw new Error("Derived memory input lacks native identity")
        const bytes = await read(path.join(dir, file), 1048576, 1048576)
        if (bytes.bytes !== found[0].bytes || sha(bytes.value) !== found[0].digest)
          throw new Error("Derived memory input differs from native component bytes")
        if (file === "state.json") {
          const state = memoryState.safeParse(JSON.parse(bytes.value))
          if (
            !state.success ||
            JSON.stringify({
              ...MemorySchema.persist(MemorySchema.parse(state.data)),
              autoInject: state.data.autoInject,
            }) !== text
          )
            eligible.index = false
        } else if (bytes.value !== text) throw new Error("Derived memory input differs from native component bytes")
        const stat = await lstat(path.join(dir, file))
        const modified = Math.floor(stat.mtimeMs)
        if (
          found[0].modified === undefined &&
          MemorySchema.Sources.some((name) => name === file) &&
          MemoryMarkdown.parse(bytes.value).length
        )
          eligible.index = false
        if (
          found[0].modified !== undefined &&
          (await lstat(path.join(dir, file), { bigint: true })).mtimeNs !==
            (BigInt(found[0].modified) - 116444736000000000n) * 100n
        )
          throw new Error("Derived memory staged timestamp differs")
        inputs.push({
          file,
          digest: sha(bytes.value),
          bytes: bytes.bytes,
          modified,
          ...(found[0].modified === undefined ? {} : { ticks: found[0].modified }),
        })
      }
      const state = memoryState.safeParse(JSON.parse(value.state))
      const rendered =
        state.success && eligible.index
          ? await MemoryIndexer.build({ root: dir, state: MemorySchema.parse(state.data) })
          : undefined
      for (const item of inputs) {
        if (item.ticks === undefined) continue
        if (
          (await lstat(path.join(dir, item.file), { bigint: true })).mtimeNs !==
          (BigInt(item.ticks) - 116444736000000000n) * 100n
        )
          throw new Error("Derived memory staged timestamp differs")
      }
      for (const selector of ["index", "ignore"] as const) {
        const file = path.join(source, selector === "index" ? "index.kmem" : ".gitignore")
        const found = native.files.filter((item) => key(item.path) === key(file))
        if (!found.length) continue
        if (found.length !== 1) throw new Error("Derived memory file has ambiguous native identity")
        const bytes = await read(path.join(dir, selector === "index" ? "index.kmem" : ".gitignore"), 1048576, 1048576)
        if (bytes.bytes !== found[0].bytes || sha(bytes.value) !== found[0].digest)
          throw new Error("Derived memory staged bytes differ from native identity")
        if (selector === "index" && !rendered) continue
        const text = selector === "index" ? rendered!.text : ignore
        if (bytes.value !== text) continue
        const evidence = {
          componentDigest: hash(value),
          selector,
          renderer: selector === "index" ? ("MemoryIndexer.build" as const) : ("MemoryState.scaffold" as const),
          inputs: selector === "index" ? inputs : [],
          rendererDigest: sha(text),
        }
        const entry = memoryDerived.parse({
          kind: "memory-derived",
          namespace: group.namespace,
          data,
          workspace: value.workspace,
          ...evidence,
          evidenceDigest: hash(evidence),
          source: file,
          dev: found[0].dev,
          ino: found[0].ino,
          bytes: found[0].bytes,
          digest: found[0].digest,
          sourceTimestampAuthority: false,
          activation: "inert",
        })
        validateMemoryDerived(entry, snapshot)
        entry.inputs.forEach((item) => Object.freeze(item))
        Object.freeze(entry.inputs)
        entries.push(Object.freeze(entry))
      }
    }
  }
  inventory(token)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, entries: Object.freeze(entries) })
  return claim
}
export function memoryDerivedGroups(token: Working, claim: MemoryDerivedClaim) {
  inventory(token)
  const state = claims.get(claim)
  if (!state || state.token !== token) throw new Error("Derived memory claim is absent or foreign")
  return state.entries
}
