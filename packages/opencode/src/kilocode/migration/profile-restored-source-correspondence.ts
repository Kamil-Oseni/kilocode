import { createHash } from "node:crypto"
import path from "node:path"
import type z from "zod"
import type { snapshot } from "./profile-bundle"
import { read } from "./profile-file"
import { inventory, lookup, type Working } from "./profile-image"
import {
  historicalDigest,
  historicalValues,
  requireHistorical,
  type HistoricalReader,
} from "./profile-restored-evidence"
import { restoredSource, restoredSources } from "./profile-restored-source-schema"

type Snapshot = z.output<typeof snapshot>
type Projection = z.output<typeof restoredSources>
type Entry = z.output<typeof restoredSource>
export type RestoredSources = Readonly<{ restoredSources?: Projection }>
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
function original(value: Projection[number], archives: readonly Snapshot[]) {
  const select = (ref: Projection[number]["prior"][number]) => {
    const matches = archives.filter((item) => item.id === ref.archive)
    if (matches.length !== 1 || historicalDigest(matches[0]) !== ref.archiveDigest)
      throw new Error("Restored source archive is absent or changed")
    return matches[0]
  }
  // Strict Snapshot output has the writer's field order; payload appends archives last.
  return JSON.stringify({ ...select(value), archives: value.prior.map(select) })
}
/** Compact references validate against already strict flattened archives, without recursive payload parsing. */
export function validateRestoredSources(raw: Projection, input: Readonly<{ archives: readonly Snapshot[] }>) {
  for (const value of restoredSources.parse(raw)) {
    const text = original(value, input.archives)
    if (Buffer.byteLength(text) !== value.bytes || sha(text) !== value.digest)
      throw new Error("Restored source original writer bytes differ")
  }
}
export function validateRestoredSource(raw: z.input<typeof restoredSource>, input: RestoredSources) {
  const entry = restoredSource.parse(raw)
  const matches = restoredSources.parse(input.restoredSources ?? []).filter((item) => item.archive === entry.archive)
  if (
    matches.length !== 1 ||
    matches[0].archiveDigest !== entry.archiveDigest ||
    historicalDigest(matches[0]) !== entry.projectionDigest
  )
    throw new Error("Restored source projection is missing or changed")
  if (
    key(entry.source) !== key(path.join(entry.data, "restore-source.json")) ||
    matches[0].bytes !== entry.bytes ||
    matches[0].digest !== entry.digest
  )
    throw new Error("Restored source native writer binding differs")
}
const brand: unique symbol = Symbol("held-restored-source")
export type RestoredSourceClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; groups: readonly Entry[]; values: Projection }>()
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
export async function bindRestoredSources(
  token: Working,
  reader: HistoricalReader,
  input: Readonly<{ archives: readonly Snapshot[] }>,
): Promise<RestoredSourceClaim> {
  requireHistorical(token, reader, input)
  const native = inventory(token)
  const { payload } = await import("./profile-bundle")
  const groups: Entry[] = []
  const values = new Map<string, Projection[number]>()
  const seen = new Set<string>()
  let budget = 0
  for (const scope of native.globals) {
    const data = scope.data
    if (seen.has(key(data))) continue
    seen.add(key(data))
    if (
      !native.roots.some(
        (root) => root.kind === "json" && root.directory && !root.absent && key(root.path) === key(data),
      )
    )
      continue
    const source = path.join(data, "restore-source.json")
    const records = native.files.filter((file) => key(file.path) === key(source))
    if (!records.length) continue
    if (records.length !== 1) throw new Error("Restored source lacks unique native identity")
    const record = records[0]
    const raw = await read(
      path.join(lookup(token, data), "restore-source.json"),
      128 * 1024 * 1024 - budget,
      128 * 1024 * 1024,
    )
    budget += raw.bytes
    if (raw.bytes !== record.bytes || sha(raw.value) !== record.digest)
      throw new Error("Restored source staged bytes differ from native identity")
    const selected = payload.parse(JSON.parse(raw.value))
    const { archives, ...current } = selected
    const value = {
      archive: current.id,
      archiveDigest: historicalDigest(current),
      prior: archives.map((item) => ({ archive: item.id, archiveDigest: historicalDigest(item) })),
      bytes: record.bytes,
      digest: record.digest,
    }
    // Defaults or writer ordering from another schema must not be fabricated into byte correspondence.
    if (original(value, historicalValues(token, reader)) !== raw.value) continue
    const prior = values.get(value.archive)
    if (prior && historicalDigest(prior) !== historicalDigest(value))
      throw new Error("Restored source original writer projections conflict")
    values.set(value.archive, value)
    groups.push(
      restoredSource.parse({
        kind: "restored-source",
        archive: value.archive,
        archiveDigest: value.archiveDigest,
        projectionDigest: historicalDigest(value),
        data,
        source,
        dev: record.dev,
        ino: record.ino,
        bytes: record.bytes,
        digest: record.digest,
        ...(record.modified === undefined ? {} : { modified: record.modified }),
        activation: "inert",
      }),
    )
    inventory(token)
  }
  const projections = restoredSources.parse([...values.values()])
  validateRestoredSources(projections, input)
  for (const entry of groups) validateRestoredSource(entry, { restoredSources: projections })
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, groups: freeze(groups), values: freeze(projections) })
  return claim
}
export function restoredSourceGroups(token: Working, claim: RestoredSourceClaim) {
  inventory(token)
  const value = claims.get(claim)
  if (!value || value.token !== token) throw new Error("Restored source claim is absent or foreign")
  return value.groups
}
export function restoredSourceValues(token: Working, claim: RestoredSourceClaim) {
  restoredSourceGroups(token, claim)
  return claims.get(claim)!.values
}
