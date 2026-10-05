import { createHash } from "node:crypto"
import path from "node:path"
import type z from "zod"
import type { snapshot } from "./profile-bundle"
import { read } from "./profile-file"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"

type Snapshot = z.output<typeof snapshot>
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, stable(item)]),
    )
  return value
}
export const historicalDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
const brand: unique symbol = Symbol("held-historical-reader")
export type HistoricalReader = Readonly<{ [brand]: true }>
const readers = new WeakMap<object, { token: Working; values: readonly Snapshot[] }>()

/** Only exact declared Global data roots may supply original archived snapshots. */
export async function readHistorical(token: Working): Promise<HistoricalReader> {
  assertWorking(token)
  const native = inventory(token)
  if (native.globals.length > 128) throw new Error("Historical Global inventory exceeds bound")
  const { payload, snapshot } = await import("./profile-bundle")
  const records = new Map<string, { digest: string; value: Snapshot }>()
  const seen = new Set<string>()
  let bytes = 0
  for (const scope of native.globals) {
    if (seen.has(key(scope.data))) continue
    seen.add(key(scope.data))
    if (
      !native.roots.some(
        (root) => root.kind === "json" && root.directory && !root.absent && key(root.path) === key(scope.data),
      )
    )
      continue
    const source = path.join(scope.data, "restore-source.json")
    const files = native.files.filter((file) => key(file.path) === key(source))
    if (!files.length) continue
    if (files.length !== 1) throw new Error("Historical source lacks unique native identity")
    const file = files[0]
    const raw = await read(
      path.join(lookup(token, scope.data), "restore-source.json"),
      128 * 1024 * 1024 - bytes,
      128 * 1024 * 1024,
    )
    bytes += raw.bytes
    if (raw.bytes !== file.bytes || createHash("sha256").update(raw.value).digest("hex") !== file.digest)
      throw new Error("Historical source differs from actual native bytes")
    const value = payload.parse(JSON.parse(raw.value))
    const { archives, ...current } = value
    for (const entry of [...archives, snapshot.parse(current)]) {
      const digest = historicalDigest(entry)
      const prior = records.get(entry.id)
      if (prior && prior.digest !== digest) throw new Error("Historical source identity has conflicting content")
      records.set(entry.id, { digest, value: entry })
      if (records.size > 64) throw new Error("Historical source inventory exceeds bound")
    }
    inventory(token)
  }
  const proof = Object.freeze({ [brand]: true as const })
  readers.set(proof, { token, values: freeze([...records.values()].map((entry) => entry.value)) })
  return proof
}
export function historicalValues(token: Working, proof: HistoricalReader) {
  inventory(token)
  const state = readers.get(proof)
  if (!state || state.token !== token) throw new Error("Historical reader belongs to another held image")
  return state.values
}
/** Serialized archives are evidence; this live comparison never grants capture authority. */
export function requireHistorical(
  token: Working,
  proof: HistoricalReader,
  input: Readonly<{ archives: readonly Snapshot[] }>,
) {
  const values = historicalValues(token, proof)
  if (input.archives.length > 64 || new Set(input.archives.map((entry) => entry.id)).size !== input.archives.length)
    throw new Error("Historical component inventory is ambiguous")
  for (const value of values) {
    const matches = input.archives.filter((entry) => entry.id === value.id)
    if (matches.length !== 1 || historicalDigest(matches[0]) !== historicalDigest(value))
      throw new Error("Historical component differs from the actual held reader")
  }
}
