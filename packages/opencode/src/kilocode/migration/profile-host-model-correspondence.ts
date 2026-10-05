import { createHash } from "node:crypto"
import path from "node:path"
import z from "zod"
import { capsule, PayloadSchema, type VerifiedCapsule } from "@opencode-ai/core/kilocode/source-capsule"
import { host } from "./profile-host"
import { assertWorking, inventory, lookup, type Working } from "./profile-image"
import { read } from "./profile-file"
import { bindHost } from "./profile-host-correspondence"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))
const models = PayloadSchema.shape.hosts.element.shape.models
export const hostModel = z
  .object({
    kind: z.literal("host-model"),
    source: z
      .string()
      .max(4096)
      .refine((file) => path.isAbsolute(file) && !/[\0\r\n]/.test(file)),
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    bytes: z.number().int().safe().nonnegative().max(1048576),
    digest,
    componentDigest: digest,
    host: z.string().uuid(),
    owner: z.string().uuid(),
    revision: z.number().int().safe().nonnegative(),
    projection: digest,
    rawBytesPreserved: z.literal(false),
    activation: z.literal("inert"),
  })
  .strict()

/** Authenticated model choices remain inert historical evidence on the destination. */
export function validateHostModel(raw: z.input<typeof hostModel>, input: unknown) {
  const entry = hostModel.parse(raw)
  const value = host.parse(input)
  if (hash(value) !== entry.componentDigest) throw new Error("Host model component differs")
  const owners = value.hosts
    .filter((item) => item.id === entry.host)
    .flatMap((item) => item.owners)
    .filter(
      (item) =>
        item.id === entry.owner &&
        item.revision === entry.revision &&
        item.root &&
        key(item.root.path) === key(entry.source),
    )
  if (owners.length !== 1 || !owners[0].models || hash(models.parse(owners[0].models)) !== entry.projection)
    throw new Error("Host model owner projection differs")
}

const brand: unique symbol = Symbol("held-host-model-correspondence")
export type HostModelClaim = Readonly<{ [brand]: true }>
const bindings = new WeakMap<object, { token: Working; groups: readonly z.output<typeof hostModel>[] }>()

/** Only roots declared by the final verified capsule may bind safe model records. */
export async function bindHostModel(token: Working, proof: VerifiedCapsule, input: unknown): Promise<HostModelClaim> {
  assertWorking(token)
  bindHost(token, proof, input)
  const verified = capsule(proof)
  if (key(lookup(token, verified.descriptor.file)) !== key(verified.selected))
    throw new Error("Host model verification is not the current staged reader")
  const value = host.parse(input)
  const native = inventory(token)
  const groups: z.output<typeof hostModel>[] = []
  for (const selected of verified.payload.hosts) {
    for (const owner of selected.owners) {
      if (!owner.root || !owner.models) continue
      const files = native.files.filter((file) => key(file.path) === key(owner.root!.path))
      if (files.length !== 1 || files[0].bytes > 1048576) continue
      if (
        !native.roots.some(
          (root) => root.kind === "json" && !root.directory && !root.absent && key(root.path) === key(owner.root!.path),
        )
      )
        continue
      const file = files[0]
      const body = await read(lookup(token, file.path), 1048576, 1048576)
      if (body.bytes !== file.bytes || createHash("sha256").update(body.value).digest("hex") !== file.digest)
        throw new Error("Host model staged bytes differ")
      const decoded = (() => {
        try {
          return models.safeParse(JSON.parse(body.value))
        } catch (err) {
          if (err instanceof SyntaxError) return undefined
          throw err
        }
      })()
      if (!decoded?.success || hash(decoded.data) !== hash(owner.models)) continue
      if (groups.some((entry) => key(entry.source) === key(file.path)))
        throw new Error("Host model native owner is ambiguous")
      const entry = hostModel.parse({
        kind: "host-model",
        source: file.path,
        dev: file.dev,
        ino: file.ino,
        bytes: file.bytes,
        digest: file.digest,
        componentDigest: hash(value),
        host: selected.id,
        owner: owner.id,
        revision: owner.revision,
        projection: hash(decoded.data),
        rawBytesPreserved: false,
        activation: "inert",
      })
      validateHostModel(entry, value)
      groups.push(Object.freeze(entry))
    }
  }
  assertWorking(token)
  const claim = Object.freeze({ [brand]: true as const })
  bindings.set(claim, { token, groups: Object.freeze(groups) })
  return claim
}

export function hostModelGroups(token: Working, claim: unknown) {
  const native = inventory(token)
  const value = typeof claim === "object" && claim !== null ? bindings.get(claim) : undefined
  if (!value || value.token !== token) throw new Error("Host model binding is absent or foreign")
  for (const group of value.groups) {
    const files = native.files.filter((file) => key(file.path) === key(group.source))
    if (
      files.length !== 1 ||
      files[0].dev !== group.dev ||
      files[0].ino !== group.ino ||
      files[0].bytes !== group.bytes ||
      files[0].digest !== group.digest
    )
      throw new Error("Host model native origin differs")
  }
  return value.groups
}
