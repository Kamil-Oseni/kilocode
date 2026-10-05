import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, realpath, stat } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import type { launch } from "./source-launch"
import { NativeProcess } from "./process-host"
import { observe } from "./source-observer"
import { IdentitySchema, serve } from "./source-pipe"
import { decode, encode, type Transfer } from "./source-transfer"
import { PayloadSchema, stage } from "./source-capsule"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const uuid = z.string().uuid()
export const ExportFileSchema = z
  .object({
    output: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => path.isAbsolute(value) && !value.includes("\0")),
    bytes: z
      .number()
      .int()
      .positive()
      .max(180 * 1024 * 1024),
    digest,
  })
  .strict()
export const ExportResultSchema = z
  .object({
    format: z.literal("raya.source-export-result"),
    version: z.literal(1),
    id: uuid,
    generation: uuid,
    source: IdentitySchema,
    receiver: IdentitySchema,
    status: z.enum(["exported", "refused"]),
    artifact: ExportFileSchema.optional(),
    completeProfileCoverage: z.literal(false),
    portableCaptureAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === "exported") !== (value.artifact !== undefined))
      ctx.addIssue({ code: "custom", message: "Source export result differs" })
  })
type Session = Awaited<ReturnType<typeof launch>>
type Input = Pick<Transfer, "profile" | "password" | "output"> & { host?: z.infer<typeof PayloadSchema> }
const sessions = new WeakMap<Session, { id: string; digest: string; pending: ReturnType<typeof transfer> }>()
const mac = (token: string, value: unknown) => createHmac("sha256", token).update(JSON.stringify(value)).digest("hex")
const same = (left: string, right: string) =>
  process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : left === right

/** A single snapshotted private transfer belongs to an already-owned native source. */
export function exportSource(session: Session, input: Input) {
  const previous = sessions.get(session)
  const id = previous?.id ?? randomUUID()
  const payload = encode({
    format: "raya.source-export",
    version: 1,
    id,
    source: {
      pid: session.ticket.header.pid,
      birth: session.ticket.header.birth,
      executable: session.ticket.header.executable,
      digest: session.ticket.header.digest,
    },
    profile: input.profile,
    password: input.password,
    output: input.output,
  })
  const host = input.host ? PayloadSchema.parse(input.host) : undefined
  const digest = createHash("sha256")
    .update(payload)
    .update(JSON.stringify(host) ?? "")
    .digest("hex")
  if (previous) {
    if (previous.digest !== digest) return Promise.reject(new Error("Source export request changed after acceptance"))
    return previous.pending
  }
  const pending = (async () => {
    const parsed = decode(payload)
    if (!host) return transfer(session, parsed, payload)
    const data = parsed.profile.data ?? path.dirname(parsed.profile.storage)
    const descriptor = await stage(session.ticket, { id, source: parsed.source, data, payload: host })
    const selected = { ...parsed, host: descriptor }
    return transfer(session, selected, encode(selected))
  })()
  sessions.set(session, { id, digest, pending })
  return pending
}

async function wait(file: string, helper: string, end: number) {
  while (performance.now() < end) {
    const info = await stat(file).catch((err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
      return undefined
    })
    if (info) {
      const receipt = await NativeProcess.receipt(file, helper)
      if (receipt) return JSON.parse(Buffer.from(receipt.data, "base64").toString("utf8")) as unknown
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Source export response deadline")
}
async function transfer(session: Session, input: Transfer, payload: string) {
  const ticket = session.ticket
  const pipe = await serve(payload, ticket.image, 60000)
  let observer: ReturnType<typeof observe> | undefined
  let outcome:
    | Readonly<{
        result: z.infer<typeof ExportResultSchema>
        family: Awaited<ReturnType<Session["retired"]>>
        code: number
      }>
    | undefined
  const errors: unknown[] = []
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  try {
    await session.handoff({ id: input.id, pipe: pipe.descriptor, purpose: "export" })
    const receiver = await session.successor(input.id)
    observer = observe({ ...receiver, timeout: 60000 })
    await observer.ready
    pipe.authorize(receiver)
    const ready = z
      .object({
        value: z
          .object({
            version: z.literal(1),
            token: z.literal(ticket.token),
            id: z.literal(input.id),
            source: IdentitySchema,
            successor: z
              .object({
                controller: z.number().int().positive(),
                birth: z.string(),
                control: z.string(),
                generation: uuid,
                id: z.literal(input.id),
              })
              .strict(),
          })
          .strict(),
        signature: digest,
      })
      .strict()
      .parse(await wait(`${ticket.control}.source-handoff-ready`, ticket.image.executable, performance.now() + 60000))
    if (
      !timingSafeEqual(Buffer.from(ready.signature, "hex"), Buffer.from(mac(ticket.token, ready.value), "hex")) ||
      ready.value.successor.controller !== receiver.pid ||
      ready.value.successor.birth !== receiver.birth ||
      ready.value.source.pid !== input.source.pid ||
      ready.value.source.birth !== input.source.birth ||
      ready.value.source.digest !== input.source.digest ||
      !same(ready.value.source.executable, input.source.executable)
    )
      throw new Error("Source export READY correlation differs")
    const settled = await Promise.race([
      Promise.all([
        pipe.done,
        session.retired(),
        observer.done,
        wait(`${ticket.control}.source-export-result`, ticket.image.executable, performance.now() + 60000),
      ]),
      new Promise<never>((_, reject) => {
        timer.id = setTimeout(() => reject(new Error("Source export retirement deadline")), 60000)
      }),
    ])
    if (settled[0].receiver !== receiver.pid) throw new Error("Source export private receiver differs")
    const envelope = z.object({ result: ExportResultSchema, signature: digest }).strict().parse(settled[3])
    const result = envelope.result
    if (
      !timingSafeEqual(Buffer.from(envelope.signature, "hex"), Buffer.from(mac(ticket.token, result), "hex")) ||
      result.id !== input.id ||
      result.generation !== ready.value.successor.generation ||
      result.source.pid !== input.source.pid ||
      result.source.birth !== input.source.birth ||
      result.source.digest !== input.source.digest ||
      !same(result.source.executable, input.source.executable) ||
      result.receiver.pid !== receiver.pid ||
      result.receiver.birth !== receiver.birth ||
      result.receiver.digest !== receiver.digest ||
      !same(result.receiver.executable, receiver.executable)
    )
      throw new Error("Source export result correlation differs")
    if (settled[2] !== (result.status === "exported" ? 0 : 1))
      throw new Error("Source export native receiver exit differs")
    if (result.artifact) {
      const info = await lstat(result.artifact.output)
      if (
        !same(await realpath(result.artifact.output), input.output) ||
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== result.artifact.bytes
      )
        throw new Error("Source export output identity differs")
      const sha = createHash("sha256")
      for await (const chunk of createReadStream(result.artifact.output)) sha.update(chunk)
      if (sha.digest("hex") !== result.artifact.digest) throw new Error("Source export output digest differs")
    }
    outcome = Object.freeze({ result, family: settled[1], code: settled[2] })
  } catch (err) {
    errors.push(err)
  } finally {
    clearTimeout(timer.id)
    await observer?.close().catch((err) => errors.push(err))
    await pipe.close().catch((err) => errors.push(err))
  }
  if (errors.length || !outcome)
    throw new Error("Source export transport refused; retirement remains unconfirmed", {
      cause: new AggregateError(errors, "Private source export failure"),
    })
  return outcome
}
