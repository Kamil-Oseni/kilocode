import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { admitProfileOperation } from "./profile-maintenance"
import { IdentitySchema } from "./source-pipe"
import { covers, validatePolicy, type SourcePolicy } from "./source-policy"
import { preferences } from "./profile-preferences"
import type { Ticket } from "./source-launch"

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)
  .refine((value) => !value.includes("://"))
const file = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value))
const root = z.object({ kind: z.literal("json"), path: file }).strict()
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const model = z.object({ providerID: identifier, modelID: identifier }).strict()
const models = z
  .object({
    selected: model.optional(),
    recent: z.array(model).max(128),
    favorite: z.array(model).max(128),
    agents: z.array(model.extend({ agent: identifier })).max(128),
    variants: preferences.shape.modelState.shape.variants,
    expanded: z.boolean().optional(),
  })
  .strict()
export const PayloadSchema = z
  .object({
    format: z.literal("raya.host-capsule"),
    version: z.literal(1),
    hosts: z
      .array(
        z
          .object({
            id: uuid,
            role: z.enum(["view", "agent-manager"]),
            revision,
            models,
            owners: z
              .array(z.object({ id: uuid, revision, root: root.optional(), models: models.optional() }).strict())
              .max(256),
            contexts: z
              .array(z.object({ id: uuid, project: identifier.optional(), path: file, root: root.optional() }).strict())
              .max(256),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
export type Payload = z.infer<typeof PayloadSchema>
export const DescriptorSchema = z.object({ file, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type Descriptor = z.infer<typeof DescriptorSchema>
const brand: unique symbol = Symbol("verified-source-capsule")
export type VerifiedCapsule = Readonly<{ [brand]: true }>
const verified = new WeakMap<
  object,
  Readonly<{ descriptor: Descriptor; payload: Payload; selected: string; bytes: number }>
>()

/** This metadata is available only for a completed real verification, never for copied JSON. */
export function capsule(proof: unknown) {
  const value = typeof proof === "object" && proof !== null ? verified.get(proof) : undefined
  if (!value) throw new Error("Host capsule verification provenance is unavailable")
  return value
}
const envelope = z
  .object({
    value: z.object({ version: z.literal(1), id: uuid, source: IdentitySchema, payload: PayloadSchema }).strict(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const bound = 1024 * 1024
const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const same = (left: z.infer<typeof IdentitySchema>, right: z.infer<typeof IdentitySchema>) =>
  left.pid === right.pid &&
  left.birth === right.birth &&
  left.digest === right.digest &&
  key(left.executable) === key(right.executable)
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
async function directory(input: string) {
  file.parse(input)
  const info = await lstat(input)
  if (!info.isDirectory() || info.isSymbolicLink() || key(await realpath(input)) !== key(input))
    throw new Error("Host capsule directory is not physically canonical")
  return input
}
async function location(data: string, target: string, policy: SourcePolicy) {
  await directory(data)
  const capture = path.join(data, "capture")
  const relative = path.relative(key(capture), key(target))
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    !covers(policy, target)
  )
    throw new Error("Host capsule is outside selected data capture namespace")
  return capture
}
async function canonical(input: string): Promise<string> {
  return realpath(input).catch(async (err: unknown) => {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT" || path.dirname(input) === input) throw err
    return path.join(await canonical(path.dirname(input)), path.basename(input))
  })
}
async function roots(payload: Payload, policy: SourcePolicy) {
  for (const host of payload.hosts)
    for (const item of [...host.owners, ...host.contexts])
      if (
        item.root &&
        (key(await canonical(item.root.path)) !== key(item.root.path) || !covers(policy, item.root.path))
      )
        throw new Error("Host capsule admitted root is outside producer policy")
}

/** Safe host evidence is signed by an already-owned source generation; it grants no capture authority. */
export async function stage(
  ticket: Ticket,
  input: { id: string; source: z.infer<typeof IdentitySchema>; data: string; payload: unknown },
): Promise<Descriptor> {
  if (!ticket.header.policy || ticket.header.version !== 2) throw new Error("Host capsule requires source policy")
  const policy = await validatePolicy(ticket.header.policy)
  const value = envelope.shape.value.parse({ version: 1, id: input.id, source: input.source, payload: input.payload })
  if (
    !same(value.source, {
      pid: ticket.header.pid,
      birth: ticket.header.birth,
      executable: ticket.header.executable,
      digest: ticket.header.digest,
    })
  )
    throw new Error("Host capsule source identity differs")
  await roots(value.payload, policy)
  const text = JSON.stringify({
    value,
    signature: createHmac("sha256", ticket.token).update(JSON.stringify(value)).digest("hex"),
  })
  if (Buffer.byteLength(text) > bound) throw new Error("Host capsule exceeds byte bound")
  const folder = path.join(input.data, "capture", randomUUID())
  const target = path.join(folder, "host.json")
  const capture = await location(input.data, target, policy)
  const lease = admitProfileOperation({ kind: "json", path: input.data })
  const state: { created: boolean; errors: unknown[]; descriptor?: Descriptor } = { created: false, errors: [] }
  try {
    await mkdir(capture, { mode: 0o700 }).catch((err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err
    })
    await directory(capture)
    await mkdir(folder, { mode: 0o700 })
    state.created = true
    await directory(folder)
    const handle = await open(target, "wx", 0o600)
    const errors: unknown[] = []
    await handle
      .writeFile(text)
      .then(() => handle.sync())
      .catch((err: unknown) => errors.push(err))
    await handle.close().catch((err: unknown) => errors.push(err))
    if (errors.length) throw new AggregateError(errors, "Host capsule persistence failed")
    state.descriptor = Object.freeze({ file: target, digest: sha(text) })
  } catch (err) {
    state.errors.push(err)
    if (state.created) {
      await (async () => {
        await directory(folder)
        await rm(folder, { recursive: true, force: true })
      })().catch((failure: unknown) => state.errors.push(failure))
    }
  }
  try {
    lease.release()
  } catch (err) {
    state.errors.push(err)
  }
  if (state.errors.length)
    throw new AggregateError(state.errors, "Host capsule write or operation release failed", { cause: state.errors[0] })
  if (!state.descriptor) throw new Error("Host capsule persistence was not confirmed")
  return state.descriptor
}

/** Authorization stays callback-owned. A staged override still must contain the exact signed bytes. */
export async function verifyCapsule(
  raw: unknown,
  expected: { id: string; source: z.infer<typeof IdentitySchema>; data: string; readPath?: string },
  authorize: () => Promise<{ policy: SourcePolicy; verify: (text: string, signature: string) => boolean }>,
): Promise<VerifiedCapsule> {
  const descriptor = DescriptorSchema.parse(raw)
  const authority = await authorize()
  const policy = await validatePolicy(authority.policy)
  await location(expected.data, descriptor.file, policy)
  const selected = expected.readPath ?? descriptor.file
  file.parse(selected)
  const before = await lstat(selected)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > bound ||
    key(await realpath(selected)) !== key(selected)
  )
    throw new Error("Host capsule file is not unique, bounded and canonical")
  const handle = await open(selected, "r")
  const bytes = await (async () => {
    try {
      const first = await handle.stat()
      if (first.dev !== before.dev || first.ino !== before.ino || first.nlink !== 1 || first.size > bound)
        throw new Error("Host capsule identity changed before read")
      const buffer = Buffer.alloc(bound + 1)
      let size = 0
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, size)
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      const after = await lstat(selected)
      if (
        size > bound ||
        after.dev !== first.dev ||
        after.ino !== first.ino ||
        after.size !== size ||
        after.nlink !== 1 ||
        after.isSymbolicLink()
      )
        throw new Error("Host capsule changed during read")
      return buffer.subarray(0, size)
    } finally {
      await handle.close()
    }
  })()
  if (!timingSafeEqual(Buffer.from(sha(bytes), "hex"), Buffer.from(descriptor.digest, "hex")))
    throw new Error("Host capsule descriptor digest differs")
  const value = envelope.parse(JSON.parse(bytes.toString("utf8")) as unknown)
  if (
    value.value.id !== expected.id ||
    !same(value.value.source, expected.source) ||
    !authority.verify(JSON.stringify(value.value), value.signature)
  )
    throw new Error("Host capsule request identity or signature differs")
  await roots(value.value.payload, policy)
  const proof = Object.freeze({ [brand]: true as const })
  verified.set(proof, freeze({ descriptor, payload: value.value.payload, selected, bytes: bytes.length }))
  return proof
}

/** Compatibility reader: verification still owns every physical, signature and policy check. */
export async function verify(
  raw: unknown,
  expected: Parameters<typeof verifyCapsule>[1],
  authorize: Parameters<typeof verifyCapsule>[2],
): Promise<Payload> {
  return capsule(await verifyCapsule(raw, expected, authorize)).payload
}
