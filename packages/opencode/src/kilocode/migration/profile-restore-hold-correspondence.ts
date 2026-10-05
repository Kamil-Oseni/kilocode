import path from "node:path"
import { createHash } from "node:crypto"
import z from "zod"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { read } from "./profile-file"
import { memory } from "./profile-memory"
import type { MemoryComponents } from "./profile-memory-correspondence"
import { namespaceID } from "./profile-secondary-schema"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value))
const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const restoreHold = z
  .object({
    kind: z.literal("restore-hold"),
    namespace: z.union([z.literal("primary"), digest]),
    data: absolute,
    workspace: absolute,
    source: absolute,
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z.number().int().safe().nonnegative().max(8192),
    digest,
    componentDigest: digest,
    activation: z.literal("inert"),
  })
  .strict()
export function validateHold(raw: z.input<typeof restoreHold>, input: MemoryComponents) {
  const entry = restoreHold.parse(raw)
  const group =
    entry.namespace === "primary"
      ? input.memory
      : input.secondary?.namespaces.find((scope) => scope.id === entry.namespace)?.memory
  const values = group?.filter((item) => key(item.workspace) === key(entry.workspace)) ?? []
  if (values.length !== 1) throw new Error("Restore hold lacks its unique memory component")
  const value = memory.parse(values[0])
  if (!value.review || hash(JSON.stringify(value)) !== entry.componentDigest)
    throw new Error("Restore hold differs from its inert memory review component")
  if (
    key(entry.source) !== key(path.join(entry.data, "storage", "raya", "restore-hold.json")) ||
    (entry.namespace !== "primary" && entry.namespace !== namespaceID(entry.data, path.join(entry.data, "storage")))
  )
    throw new Error("Restore hold physical selector differs")
  if (Buffer.byteLength(value.review.receiptText) !== entry.bytes || value.review.receiptDigest !== entry.digest)
    throw new Error("Restore hold exact source bytes differ")
}
const brand: unique symbol = Symbol("held-inert-restore-hold")
export type HoldClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; entries: readonly z.output<typeof restoreHold>[] }>()
/** Account for a current marker's held receipt as inert data, never as a release request. */
export async function bindHold(token: Working, input: MemoryComponents): Promise<HoldClaim> {
  const native = inventory(token)
  const image = assertWorking(token)
  const entries: z.output<typeof restoreHold>[] = []
  const seen = new Set<string>()
  for (const scope of native.globals) {
    const source = path.join(scope.data, "storage", "raya", "restore-hold.json")
    if (seen.has(key(source))) continue
    const files = native.files.filter((file) => key(file.path) === key(source))
    if (!files.length) continue
    if (files.length !== 1) throw new Error("Restore hold lacks unique native identity")
    const namespace =
      key(lookup(token, scope.data)) === key(image.profile.data)
        ? "primary"
        : namespaceID(scope.data, path.join(scope.data, "storage"))
    const group =
      namespace === "primary" ? input.memory : input.secondary?.namespaces.find((item) => item.id === namespace)?.memory
    const candidates = group?.filter((item) => item.review?.receiptDigest === files[0].digest) ?? []
    if (!candidates.length) continue
    const value = memory.parse(candidates[0])
    if (!value.review) throw new Error("Restore hold has no current memory review")
    const marker = path.join(scope.data, "memory", MemoryPaths.declared(value.workspace).folder, "restore.json")
    const markers = native.files.filter((file) => key(file.path) === key(marker))
    if (
      markers.length !== 1 ||
      markers[0].digest !== value.review.markerDigest ||
      markers[0].bytes !== Buffer.byteLength(value.review.markerText)
    )
      throw new Error("Restore hold lacks its exact current native marker")
    const raw = await read(path.join(lookup(token, scope.data), "storage", "raya", "restore-hold.json"), 8192, 8192)
    if (raw.value !== value.review.receiptText) throw new Error("Restore hold differs from actual held receipt")
    const file = files[0]
    const entry = restoreHold.parse({
      kind: "restore-hold",
      namespace,
      data: scope.data,
      workspace: value.workspace,
      source,
      dev: file.dev,
      ino: file.ino,
      bytes: file.bytes,
      digest: file.digest,
      componentDigest: hash(JSON.stringify(value)),
      activation: "inert",
    })
    validateHold(entry, input)
    inventory(token)
    entries.push(Object.freeze(entry))
    seen.add(key(source))
  }
  const proof = Object.freeze({ [brand]: true as const })
  claims.set(proof, { token, entries: Object.freeze(entries) })
  return proof
}
export function holdGroups(token: Working, proof: HoldClaim) {
  inventory(token)
  const state = claims.get(proof)
  if (!state || state.token !== token) throw new Error("Restore hold claim belongs to another held image")
  return state.entries
}
