import path from "node:path"
import { createHash } from "node:crypto"
import type z from "zod"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { read } from "./profile-file"
import { namespaceID } from "./profile-secondary-schema"
import {
  operational,
  operationalEntry,
  operationalPolicy,
  operationalPolicies,
  operationalDigest,
} from "./profile-operational-schema"

const key = (value: string) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value))
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const item of Object.values(value)) freeze(item)
  }
  return value
}
const reader: unique symbol = Symbol("held-operational-reader")
export type OperationalReader = Readonly<{ [reader]: true }>
const readers = new WeakMap<object, { token: Working; value: z.output<typeof operational> }>()
/** No diagnostic content is opened: its explicit omission is bound to native image identities only. */
export async function readOperational(token: Working): Promise<OperationalReader> {
  const image = assertWorking(token)
  const native = inventory(token)
  const entries: z.output<typeof operationalEntry>[] = []
  const seen = new Set<string>()
  if (native.globals.length > 256) throw new Error("Operational Global inventory exceeds bound")
  for (const scope of native.globals) {
    const namespace =
      key(lookup(token, scope.data)) === key(image.profile.data)
        ? "primary"
        : namespaceID(scope.data, path.join(scope.data, "storage"))
    for (const role of operationalEntry.shape.role.options) {
      const policy = operationalPolicies[role]
      const root = policy.scope === "storage" ? path.join(scope.data, "storage") : scope[policy.scope]
      if (!native.roots.some((entry) => entry.kind === "json" && key(entry.path) === key(root) && !entry.absent))
        continue
      const source = path.join(root, policy.file)
      if (seen.has(key(source))) continue
      const files = native.files.filter((item) => key(item.path) === key(source))
      if (!files.length) continue
      if (files.length !== 1) throw new Error("Operational entry lacks unique native identity")
      const file = files[0]
      if (("bytes" in policy && file.bytes !== policy.bytes) || ("digest" in policy && file.digest !== policy.digest))
        continue
      if (role === "telemetry-identity") {
        const bytes = await read(path.join(lookup(token, root), policy.file), 36, 36)
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bytes.value)) continue
        const digest = createHash("sha256").update(bytes.value).digest("hex")
        if (bytes.bytes !== file.bytes || digest !== file.digest)
          throw new Error("Operational identity differs from native bytes")
      }
      inventory(token)
      entries.push(
        operationalEntry.parse({
          namespace,
          data: scope.data,
          root,
          role,
          source: file.path,
          dev: file.dev,
          ino: file.ino,
          bytes: file.bytes,
          digest: file.digest,
          omission: policy.omission,
          rawBytesPreserved: false,
          activation: "inert",
        }),
      )
      seen.add(key(source))
    }
  }
  const value = operational.parse({
    format: "raya.operational-omission-evidence",
    version: 1,
    activation: "inert",
    entries,
  })
  inventory(token)
  const proof = Object.freeze({ [reader]: true as const })
  readers.set(proof, { token, value: freeze(value) })
  return proof
}
export function operationalValues(token: Working, proof: OperationalReader) {
  inventory(token)
  const state = readers.get(proof)
  if (!state || state.token !== token) throw new Error("Operational reader belongs to another image")
  return state.value.entries.length ? state.value : undefined
}
export function validateOperational(
  raw: z.input<typeof operationalPolicy>,
  input: Readonly<{ operational?: z.output<typeof operational> }>,
) {
  const entry = operationalPolicy.parse(raw)
  const value = operational.parse(input.operational)
  if (operationalDigest(value) !== entry.componentDigest) throw new Error("Operational component differs")
  const { kind: _kind, component: _component, componentDigest: _digest, ...record } = entry
  if (value.entries.filter((item) => JSON.stringify(item) === JSON.stringify(record)).length !== 1)
    throw new Error("Operational entry differs from its actual reader inventory")
  if (entry.namespace !== "primary" && entry.namespace !== namespaceID(entry.data, path.join(entry.data, "storage")))
    throw new Error("Operational namespace identity differs")
}
const brand: unique symbol = Symbol("held-operational-correspondence")
export type OperationalClaim = Readonly<{ [brand]: true }>
const claims = new WeakMap<object, { token: Working; records: readonly z.output<typeof operationalPolicy>[] }>()
export function bindOperational(
  token: Working,
  proof: OperationalReader,
  input: Readonly<{ operational?: z.output<typeof operational> }>,
): OperationalClaim {
  const value = operationalValues(token, proof)
  if (JSON.stringify(value) !== JSON.stringify(input.operational))
    throw new Error("Operational component differs from actual held reader")
  const records = value
    ? value.entries.map((entry) =>
        operationalPolicy.parse({
          ...entry,
          kind: "operational-policy",
          component: "operational",
          componentDigest: operationalDigest(value),
        }),
      )
    : []
  for (const entry of records) validateOperational(entry, input)
  const claim = Object.freeze({ [brand]: true as const })
  claims.set(claim, { token, records: freeze(records) })
  return claim
}
export function operationalGroups(token: Working, claim: OperationalClaim) {
  inventory(token)
  const state = claims.get(claim)
  if (!state || state.token !== token) throw new Error("Operational claim belongs to another image")
  return state.records
}
