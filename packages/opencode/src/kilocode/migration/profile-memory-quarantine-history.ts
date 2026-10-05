import { createHash } from "node:crypto"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { quarantine, quarantineReference } from "./profile-memory-quarantine-schema"

const limit = 32 * 1048576
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const key = (file: string) => path.normalize(file).toLowerCase()
const id = (value: { source: string; digest: string }) => value.source + ":" + value.digest
const pointer = z.object({ source: absolute, digest }).strict()
const record = z
  .object({
    source: absolute,
    workspace: absolute,
    bytes: z.number().int().safe().nonnegative().max(limit),
    digest,
    activation: z.literal("inert"),
    encoding: z.object({ bom: z.boolean(), prior: z.boolean() }).strict(),
    entries: z.array(quarantineReference).max(64),
    prior: z.array(pointer).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      path.basename(value.source) !== "restore-quarantine.json" ||
      path.basename(path.dirname(value.source)) !== MemoryPaths.declared(value.workspace).folder
    )
      ctx.addIssue({ code: "custom", message: "Memory quarantine sidecar selector differs" })
    if (
      new Set(value.entries.map(id)).size !== value.entries.length ||
      new Set(value.prior.map(id)).size !== value.prior.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate quarantine projection reference" })
  })
export const quarantineLineage = z
  .object({ version: z.literal(1), activation: z.literal("inert"), records: z.array(record).max(64) })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    const paths = new Map<string, string>()
    for (const item of value.records) {
      if (seen.has(id(item))) ctx.addIssue({ code: "custom", message: "Duplicate quarantine sidecar record" })
      if (paths.has(key(item.source)) && paths.get(key(item.source)) !== item.source)
        ctx.addIssue({ code: "custom", message: "Quarantine sidecar source case conflict" })
      paths.set(key(item.source), item.source)
      if (item.prior.some((prior) => !seen.has(id(prior))))
        ctx.addIssue({ code: "custom", message: "Quarantine sidecar prior is unknown, forward or cyclic" })
      seen.add(id(item))
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1048576)
      ctx.addIssue({ code: "custom", message: "Quarantine lineage exceeds metadata bound" })
  })
export const quarantineSidecar = z
  .object({
    format: z.literal("raya.restored-memory-quarantine"),
    version: z.literal(1),
    activation: z.literal("inert"),
    entries: quarantine,
    prior: quarantineLineage.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const entries = new Map(value.entries.map(({ text: _, ...entry }) => [id(entry), entry]))
    for (const item of value.prior?.records ?? []) {
      for (const entry of item.entries) {
        if (JSON.stringify(entries.get(id(entry))) !== JSON.stringify(entry))
          ctx.addIssue({ code: "custom", message: "Quarantine sidecar entry projection differs" })
      }
      const bodies = item.entries.map((entry) => value.entries.find((body) => id(body) === id(entry)))
      const records = item.prior.map((entry) => value.prior?.records.find((prior) => id(prior) === id(entry)))
      if (bodies.some((entry) => !entry) || records.some((entry) => !entry)) {
        ctx.addIssue({ code: "custom", message: "Quarantine sidecar reconstruction reference is absent" })
        continue
      }
      if (!item.encoding.prior && records.length)
        ctx.addIssue({ code: "custom", message: "Quarantine sidecar omitted prior has references" })
      const raw =
        (item.encoding.bom ? "\ufeff" : "") + JSON.stringify(wrapper(bodies, item.encoding.prior ? records : undefined))
      if (Buffer.byteLength(raw) !== item.bytes || createHash("sha256").update(raw).digest("hex") !== item.digest)
        ctx.addIssue({ code: "custom", message: "Quarantine sidecar exact writer reconstruction differs" })
    }
    if (Buffer.byteLength(JSON.stringify(value)) > limit)
      ctx.addIssue({ code: "custom", message: "Quarantine sidecar exceeds serialized bound" })
  })
function wrapper(entries: readonly unknown[], records?: readonly unknown[]) {
  return {
    format: "raya.restored-memory-quarantine",
    version: 1,
    activation: "inert",
    entries,
    ...(records ? { prior: { version: 1, activation: "inert", records } } : {}),
  }
}
export function renderQuarantine(entries: z.input<typeof quarantine>, lineage?: z.input<typeof quarantineLineage>) {
  const records = new Map<string, z.input<typeof record>>()
  for (const item of lineage?.records ?? []) {
    const prior = records.get(id(item))
    if (prior && JSON.stringify(prior) !== JSON.stringify(item))
      throw new Error("Conflicting quarantine sidecar record")
    records.set(id(item), item)
  }
  return quarantineSidecar.parse({
    format: "raya.restored-memory-quarantine",
    version: 1,
    activation: "inert",
    entries,
    ...(lineage ? { prior: { ...lineage, records: [...records.values()] } } : {}),
  })
}
const same = (one: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, two: typeof one) =>
  one.dev === two.dev &&
  one.ino === two.ino &&
  one.size === two.size &&
  one.mtimeNs === two.mtimeNs &&
  one.ctimeNs === two.ctimeNs
/** Reads inert data only; neither serialized lineage nor this return value grants capture authority. */
export async function readQuarantineSidecar(file: string, input: { source?: string; workspace: string }) {
  absolute.parse(file)
  absolute.parse(input.workspace)
  if (path.basename(file) !== "restore-quarantine.json") throw new Error("Quarantine sidecar filename differs")
  const info = await lstat(file, { bigint: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return undefined
  const dir = path.dirname(file)
  const parent = await lstat(dir, { bigint: true })
  if (!parent.isDirectory() || parent.isSymbolicLink() || key(await realpath(dir)) !== key(dir))
    throw new Error("Quarantine sidecar parent is not canonical")
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(limit))
    throw new Error("Quarantine sidecar is not a bounded unique regular file")
  const handle = await open(file, "r")
  const errors: unknown[] = []
  const result: { entries: z.output<typeof quarantine>; lineage: z.output<typeof quarantineLineage> | undefined }[] = []
  try {
    const before = await handle.stat({ bigint: true })
    if (!same(info, before) || !before.isFile() || before.nlink !== 1n)
      throw new Error("Quarantine sidecar identity changed before read")
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const final = await lstat(file, { bigint: true })
    const end = await lstat(dir, { bigint: true })
    if (
      offset !== Number(before.size) ||
      !same(before, after) ||
      !same(before, final) ||
      !final.isFile() ||
      final.isSymbolicLink() ||
      final.nlink !== 1n ||
      !same(parent, end) ||
      !end.isDirectory() ||
      end.isSymbolicLink() ||
      key(await realpath(dir)) !== key(dir)
    )
      throw new Error("Quarantine sidecar binding changed during read")
    const raw = bytes.subarray(0, offset)
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
    if (!Buffer.from(text).equals(raw)) throw new Error("Quarantine sidecar UTF8 does not round trip")
    const parsed = quarantineSidecar.parse(JSON.parse(text.startsWith("\ufeff") ? text.slice(1) : text))
    const bom = text.startsWith("\ufeff")
    if (text !== (bom ? "\ufeff" : "") + JSON.stringify(wrapper(parsed.entries, parsed.prior?.records)))
      throw new Error("Quarantine sidecar is not exact canonical writer JSON")
    if (!input.source) {
      result.push({ entries: parsed.entries, lineage: parsed.prior })
    }
    if (input.source) {
      const current = record.parse({
        source: input.source,
        workspace: input.workspace,
        bytes: raw.length,
        digest: createHash("sha256").update(raw).digest("hex"),
        activation: "inert",
        encoding: { bom, prior: parsed.prior !== undefined },
        entries: parsed.entries.map(({ text: _, ...entry }) => entry),
        prior: (parsed.prior?.records ?? []).map(({ source, digest }) => ({ source, digest })),
      })
      const rendered = renderQuarantine(parsed.entries, {
        version: 1,
        activation: "inert",
        records: [...(parsed.prior?.records ?? []), current],
      })
      result.push({ entries: rendered.entries, lineage: rendered.prior })
    }
  } catch (err) {
    errors.push(err)
  } finally {
    await handle.close().catch((err: unknown) => errors.push(err))
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, "Quarantine sidecar read and handle cleanup failed")
  return result[0]
}
