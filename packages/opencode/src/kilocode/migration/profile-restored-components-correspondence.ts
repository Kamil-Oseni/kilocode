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
import { restoredComponent, restoredComponents } from "./profile-restored-components-schema"
import { allocatorLedger } from "./profile-sql-metadata"
import { reviewContext, validateReview } from "./profile-restore-review-schema"
import { projectStores } from "./profile-store-projection"
import { identity } from "./profile-workspaces"

type Entry = z.output<typeof restoredComponent>
type Projection = z.output<typeof restoredComponents>
type Snapshot = z.output<typeof snapshot>
export type RestoredComponents = Readonly<{ restoredComponents?: Projection }>
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const routes = {
  config: "restore-config.json",
  disposition: "restore-disposition.json",
  secondary: "restore-secondary.json",
  voice: "restore-voice-reconciliation.json",
  operational: "restore-operational.json",
  host: "restore-host.json",
  tui: "restore-tui.json",
  preferences: "restore-preferences.json",
  notes: "restore-notes.json",
  outputs: "restore-outputs.json",
  selfHeal: "restore-self-heal.json",
  sqlMetadata: "restore-sql-metadata.json",
  review: "restore-review.json",
  stores: "restore-stores.json",
  exports: "restore-exports.json",
} as const
function component(value: Snapshot, selector: Entry["selector"], context?: z.output<typeof reviewContext>) {
  if (selector === "sqlMetadata") return allocatorLedger(value.disposition)
  if (selector !== "review" && selector !== "stores") return value[selector]
  if (!context) return undefined
  const review = validateReview(context, value)
  if (selector === "review") return review
  if (review.version !== 2) return undefined
  const stores = projectStores(value, new Map(Object.entries(review.workspaces)), review.storesAt)
  return stores === undefined
    ? undefined
    : { format: "raya.inactive-profile-stores", version: 1, activation: "held", stores }
}
/** Validation refers only to already strict archived components; it never accepts an arbitrary JSON component. */
export function validateRestoredComponents(raw: Projection, input: Readonly<{ archives: readonly Snapshot[] }>) {
  const values = restoredComponents.parse(raw)
  for (const value of values) {
    const archives = input.archives.filter((item) => item.id === value.archive)
    if (archives.length !== 1 || historicalDigest(archives[0]) !== value.archiveDigest)
      throw new Error("Restored component archive is absent or changed")
    if (value.context && value.selector !== "review" && value.selector !== "stores")
      throw new Error("Original-only restored component has unexpected writer context")
    const selected = component(archives[0], value.selector, value.context)
    if (
      selected === undefined ||
      historicalDigest(selected) !== value.componentDigest ||
      JSON.stringify(selected) !== value.text
    )
      throw new Error("Restored component original writer projection differs")
  }
}
export function validateRestoredComponent(raw: z.input<typeof restoredComponent>, input: RestoredComponents) {
  const entry = restoredComponent.parse(raw)
  const values = restoredComponents
    .parse(input.restoredComponents ?? [])
    .filter((item) => item.archive === entry.archive && item.selector === entry.selector)
  if (
    values.length !== 1 ||
    values[0].archiveDigest !== entry.archiveDigest ||
    values[0].componentDigest !== entry.componentDigest
  )
    throw new Error("Restored component projection is missing or changed")
  const value = values[0]
  if (value.context && key(value.context.data) !== key(entry.data))
    throw new Error("Restored component review namespace differs")
  if (
    key(entry.source) !== key(path.join(entry.data, routes[entry.selector])) ||
    Buffer.byteLength(value.text) !== entry.bytes ||
    sha(value.text) !== entry.digest
  )
    throw new Error("Restored component exact original writer bytes differ")
}
const brand: unique symbol = Symbol("held-restored-components")
export type RestoredComponentClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; groups: readonly Entry[]; values: Projection }>()
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  return value
}
export async function bindRestoredComponents(
  token: Working,
  reader: HistoricalReader,
  input: Readonly<{ archives: readonly Snapshot[] }>,
): Promise<RestoredComponentClaim> {
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
    const origin = native.files.filter((file) => key(file.path) === key(path.join(data, "restore-source.json")))
    if (!origin.length) continue
    if (origin.length !== 1) throw new Error("Restored component source lacks unique native identity")
    const staged = lookup(token, data)
    const raw = await read(path.join(staged, "restore-source.json"), 128 * 1024 * 1024 - budget, 128 * 1024 * 1024)
    budget += raw.bytes
    if (raw.bytes !== origin[0].bytes || sha(raw.value) !== origin[0].digest)
      throw new Error("Restored component source differs from native bytes")
    const selected = payload.parse(JSON.parse(raw.value))
    const archives = historicalValues(token, reader).filter((item) => item.id === selected.id)
    if (archives.length !== 1) throw new Error("Restored component current source is not in the held reader")
    const archive = archives[0]
    const archiveDigest = historicalDigest(archive)
    const context = await readReviewContext(token, data, archive)
    for (const name of Object.keys(routes)) {
      const selector = restoredComponent.shape.selector.parse(name)
      const derived = selector === "review" || selector === "stores"
      const selected = component(archive, selector, derived ? context : undefined)
      if (selected === undefined) continue
      const source = path.join(data, routes[selector])
      const records = native.files.filter((file) => key(file.path) === key(source))
      if (!records.length) continue
      if (records.length !== 1) throw new Error("Restored component file lacks unique native identity")
      const record = records[0]
      const encoded = await read(path.join(staged, routes[selector]), 64 * 1024 * 1024, 64 * 1024 * 1024)
      if (encoded.bytes !== record.bytes || sha(encoded.value) !== record.digest)
        throw new Error("Restored component staged bytes differ from native identity")
      const text = JSON.stringify(selected)
      if (encoded.value !== text) continue
      const value = {
        archive: archive.id,
        archiveDigest,
        selector,
        componentDigest: historicalDigest(selected),
        text,
        ...(derived ? { context } : {}),
      }
      values.set(archive.id + ":" + selector, value)
      groups.push(
        restoredComponent.parse({
          kind: "restored-component",
          archive: value.archive,
          archiveDigest,
          selector,
          componentDigest: value.componentDigest,
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
    }
    inventory(token)
  }
  const projections = restoredComponents.parse([...values.values()])
  const components = { archives: input.archives, restoredComponents: projections }
  validateRestoredComponents(projections, components)
  for (const entry of groups) validateRestoredComponent(entry, components)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, groups: freeze(groups), values: freeze(projections) })
  return claim
}
export function restoredComponentGroups(token: Working, claim: RestoredComponentClaim) {
  inventory(token)
  const value = claims.get(claim)
  if (!value || value.token !== token) throw new Error("Restored component claim is absent or foreign")
  return value.groups
}
export function restoredComponentValues(token: Working, claim: RestoredComponentClaim) {
  restoredComponentGroups(token, claim)
  return claims.get(claim)!.values
}

export async function readReviewContext(token: Working, data: string, original: z.output<typeof snapshot>) {
  const native = inventory(token)
  const files = ["restore-review.json", "storage/raya/restore-hold.json"].map((relative) =>
    native.files.filter((file) => identity(file.path) === identity(path.join(data, relative))),
  )
  if (files.some((entries) => entries.length === 0)) return undefined
  if (files.some((entries) => entries.length !== 1)) throw new Error("Restore review lacks unique native files")
  const staged = lookup(token, data)
  const encoded = await read(path.join(staged, "restore-review.json"), 65536, 65536)
  const held = await read(path.join(staged, "storage/raya/restore-hold.json"), 8192, 8192)
  for (const [raw, entry] of [
    [encoded, files[0][0]],
    [held, files[1][0]],
  ] as const)
    if (raw.bytes !== entry.bytes || createHash("sha256").update(raw.value).digest("hex") !== entry.digest)
      throw new Error("Restore review differs from exact held native bytes")
  const saved = files[1][0]
  const value = reviewContext.parse({
    data,
    reviewText: encoded.value,
    receiptText: held.value,
    receipt: { source: saved.path, dev: saved.dev, ino: saved.ino, bytes: saved.bytes, digest: saved.digest },
  })
  try {
    const review = validateReview(value, original)
    if (JSON.stringify(review) !== encoded.value) return undefined
    return value
  } catch {
    return undefined
  }
}
