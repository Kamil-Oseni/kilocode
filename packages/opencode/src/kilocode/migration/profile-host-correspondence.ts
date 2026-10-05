import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { capsule, type VerifiedCapsule } from "@opencode-ai/core/kilocode/source-capsule"
import { host } from "./profile-host"
import { assertWorking, lookup, origin, type Working } from "./profile-image"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const key = (file: string) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file))
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
export const hostTransform = z
  .object({
    kind: z.literal("host-semantic"),
    source: z
      .string()
      .min(1)
      .max(4096)
      .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file)),
    identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict(),
    bytes: z.number().int().safe().nonnegative().max(1048576),
    sourceDigest: digest,
    projection: digest,
    digest,
    hosts: z
      .array(z.object({ id: z.string().uuid(), revision: z.number().int().safe().nonnegative(), digest }).strict())
      .max(64),
    rawBytesPreserved: z.literal(false),
    envelopeAuthority: z.literal("excluded"),
    historicalIntent: z.literal("inert"),
    activation: z.literal("held"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.hosts.map((item) => item.id)).size !== value.hosts.length)
      ctx.addIssue({ code: "custom", message: "Host correspondence current identities are ambiguous" })
  })

/** Safe semantic correspondence supplies no restored process, signature or controller authority. */
export function validateHost(raw: z.input<typeof hostTransform>, input: unknown) {
  const value = hostTransform.parse(raw)
  const evidence = host.parse(input)
  if (hash(evidence) !== value.digest || new Set(evidence.hosts.map((item) => item.id)).size !== evidence.hosts.length)
    throw new Error("Host correspondence archived component differs")
  const hosts = value.hosts.map((record) => {
    const item = evidence.hosts.find((item) => item.id === record.id)
    if (!item || item.revision !== record.revision || hash(item) !== record.digest)
      throw new Error("Host correspondence current projection differs")
    return item
  })
  if (hash({ format: "raya.host-capsule", version: 1, hosts }) !== value.projection)
    throw new Error("Host correspondence current component differs")
}

const brand: unique symbol = Symbol("held-host-correspondence")
export type HostClaim = Readonly<{ [brand]: true }>
const bindings = new WeakMap<object, { token: Working; groups: readonly z.output<typeof hostTransform>[] }>()

/** Only the final authenticated staged read can bind the exact held capsule file. */
export function bindHost(token: Working, proof: VerifiedCapsule, raw: unknown): HostClaim {
  assertWorking(token)
  const verified = capsule(proof)
  if (key(lookup(token, verified.descriptor.file)) !== key(verified.selected))
    throw new Error("Host correspondence verification is not the current staged reader")
  const source = origin(token, verified.descriptor.file)
  if (source.digest !== verified.descriptor.digest || source.bytes !== verified.bytes)
    throw new Error("Host correspondence held source bytes differ")
  const evidence = host.parse(raw)
  const value = hostTransform.parse({
    kind: "host-semantic",
    source: verified.descriptor.file,
    identity: { dev: source.dev, ino: source.ino },
    bytes: source.bytes,
    sourceDigest: source.digest,
    projection: hash(verified.payload),
    digest: hash(evidence),
    hosts: verified.payload.hosts.map((item) => ({ id: item.id, revision: item.revision, digest: hash(item) })),
    rawBytesPreserved: false,
    envelopeAuthority: "excluded",
    historicalIntent: "inert",
    activation: "held",
  })
  validateHost(value, evidence)
  const claim = Object.freeze({ [brand]: true as const })
  assertWorking(token)
  bindings.set(claim, { token, groups: Object.freeze([freeze(value)]) })
  return claim
}

/** Serialized claims, expired callbacks and foreign images cannot provide native file accounting. */
export function hostGroups(token: Working, claim: unknown) {
  assertWorking(token)
  const value = typeof claim === "object" && claim !== null ? bindings.get(claim) : undefined
  if (!value || value.token !== token)
    throw new Error("Host correspondence binding is absent or belongs to another image")
  for (const group of value.groups) {
    const source = origin(token, group.source)
    if (
      source.dev !== group.identity.dev ||
      source.ino !== group.identity.ino ||
      source.bytes !== group.bytes ||
      source.digest !== group.sourceDigest
    )
      throw new Error("Host correspondence native origin differs")
  }
  return value.groups
}
