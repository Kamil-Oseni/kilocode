import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import z from "zod"
import { NativeProcess } from "./process-host"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const IdentitySchema = z
  .object({
    pid: z.number().int().positive().max(0xffffffff),
    birth: z.string().regex(/^\d{1,20}$/),
    executable: z.string().min(1).max(4096),
    digest,
  })
  .strict()
export const DescriptorSchema = z
  .object({ name: z.string().regex(/^\\\\\.\\pipe\\raya-profile-[a-f0-9-]{36}$/), server: IdentitySchema })
  .strict()
export type Descriptor = Readonly<{ name: string; server: Readonly<z.infer<typeof IdentitySchema>> }>
export type Pin = Readonly<{ executable: string; digest: string }>
const hash = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
async function image(pin?: Pin) {
  const file = await NativeProcess.source(pin?.executable)
  if (pin && (await realpath(file)).toLowerCase() !== (await realpath(pin.executable)).toLowerCase())
    throw new Error("Private pipe helper path changed")
  const sum = await hash(file)
  if (pin && sum !== pin.digest) throw new Error("Private pipe helper hash changed")
  return { executable: file, digest: sum }
}
function frame(...values: (number | string | Buffer)[]) {
  const body = Buffer.concat(
    values.map((value) => {
      if (Buffer.isBuffer(value)) return value
      const length = Buffer.alloc(4)
      if (typeof value === "number") {
        length.writeUInt32LE(value)
        return length
      }
      length.writeUInt32LE(value.length)
      return Buffer.concat([length, Buffer.from(value, "utf16le")])
    }),
  )
  if (body.length > 32768) throw new Error("Private pipe frame exceeded bound")
  const length = Buffer.alloc(4)
  length.writeUInt32LE(body.length)
  return Buffer.concat([length, body])
}

/** The secret is sent on private stdin only; authorization comes after native broker READY. */
export async function serve(secret: string, pin?: Pin, timeout = 60000) {
  z.number().int().min(100).max(60000).parse(timeout)
  const bytes = Buffer.from(secret, "utf8")
  if (!bytes.length || bytes.length > 4096 || secret.includes("\0"))
    throw new Error("Private pipe secret is empty or exceeded bound")
  const helper = await image(pin)
  const child = spawn(helper.executable, ["source-pipe-serve"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  const state = { authorized: false, closed: false, receiver: 0 }
  const timer = setTimeout(() => {
    state.closed = true
    child.kill()
  }, timeout + 5000)
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) =>
      code === 0 && !signal ? resolve(0) : reject(new Error(`Private pipe server refused (${code}/${signal})`)),
    )
  }).finally(() => clearTimeout(timer))
  void exit.catch(() => undefined)
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  const ready = (() => {
    const state = { resolve: (_value: Descriptor) => {}, reject: (_err: unknown) => {} }
    const promise = new Promise<Descriptor>((resolve, reject) => {
      state.resolve = resolve
      state.reject = reject
    })
    return {
      promise,
      resolve: (value: Descriptor) => state.resolve(value),
      reject: (err: unknown) => state.reject(err),
    }
  })()
  child.stderr.on("data", (value: Buffer) => {
    if (errors.reduce((size, part) => size + part.length, 0) < 8192) errors.push(value)
  })
  child.stdout.on("data", (value: Buffer) => {
    chunks.push(value)
    const text = Buffer.concat(chunks).toString("utf8")
    if (text.length > 8192) {
      ready.reject(new Error("Private pipe server output exceeded bound"))
      child.kill()
      return
    }
    const end = text.indexOf("\n")
    if (end === -1) return
    try {
      const parsed = DescriptorSchema.parse(JSON.parse(text.slice(0, end)))
      if (
        parsed.server.pid !== child.pid ||
        parsed.server.digest !== helper.digest ||
        parsed.server.executable.toLowerCase() !== helper.executable.toLowerCase()
      )
        throw new Error("Private pipe server pin changed")
      ready.resolve(Object.freeze({ name: parsed.name, server: Object.freeze(parsed.server) }))
    } catch (err) {
      ready.reject(err)
      child.kill()
    }
  })
  void exit.catch((err) =>
    ready.reject(new AggregateError([err, Buffer.concat(errors).toString()], "Private pipe server startup refused")),
  )
  const payload = frame(1, `\\\\.\\pipe\\raya-profile-${randomUUID()}`, timeout, bytes.length, bytes)
  child.stdin.write(payload, (err) => {
    payload.fill(0)
    bytes.fill(0)
    if (err) ready.reject(err)
  })
  const descriptor = await ready.promise.catch(async (err: unknown) => {
    state.closed = true
    if (child.exitCode === null) child.kill()
    const errors: unknown[] = [err]
    await exit.catch((failure: unknown) => {
      errors.push(failure)
    })
    throw new AggregateError(errors, "Private pipe startup could not be confirmed")
  })
  const done = exit.then(() => {
    const lines = Buffer.concat(chunks).toString().trim().split("\n")
    const parsed = z
      .object({ received: z.literal(true), receiver: z.number().int().positive() })
      .strict()
      .parse(JSON.parse(lines[1] ?? "null"))
    if (!state.authorized || state.closed || parsed.receiver !== state.receiver)
      throw new Error("Private pipe completed without exact receiver authorization")
    return Object.freeze(parsed)
  })
  void done.catch(() => undefined)
  return Object.freeze({
    descriptor,
    done,
    authorize(receiver: z.infer<typeof IdentitySchema>) {
      const value = IdentitySchema.parse(receiver)
      if (state.authorized || state.closed) throw new Error("Private pipe authorization is closed")
      state.authorized = true
      state.receiver = value.pid
      child.stdin.end(frame(1, value.pid, value.birth, value.executable, value.digest))
    },
    async close() {
      if (!state.closed && child.exitCode === null) {
        state.closed = true
        child.kill()
      }
      await exit
    },
  })
}

/** Native server PID/birth/image and the client's kernel parent are checked before payload delivery. */
export async function receive(raw: unknown, pin?: Pin, timeout = 60000) {
  z.number().int().min(100).max(60000).parse(timeout)
  const descriptor = DescriptorSchema.parse(raw)
  const helper = await image(pin)
  if (
    helper.executable.toLowerCase() !== descriptor.server.executable.toLowerCase() ||
    helper.digest !== descriptor.server.digest
  )
    throw new Error("Private pipe server is not the pinned helper")
  const child = spawn(helper.executable, ["source-pipe-receive"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  const timer = setTimeout(() => child.kill(), timeout + 5000)
  child.stdout.on("data", (value: Buffer) => {
    chunks.push(value)
    if (chunks.reduce((size, part) => size + part.length, 0) > 4096) child.kill()
  })
  child.stderr.on("data", (value: Buffer) => {
    if (errors.reduce((size, part) => size + part.length, 0) < 8192) errors.push(value)
  })
  const code = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) =>
      code === 0 && !signal
        ? resolve()
        : reject(new Error(`Private pipe receiver refused (${code}/${signal}): ${Buffer.concat(errors).toString()}`)),
    )
  }).finally(() => clearTimeout(timer))
  child.stdin.end(
    frame(
      1,
      descriptor.name,
      descriptor.server.pid,
      descriptor.server.birth,
      descriptor.server.executable,
      descriptor.server.digest,
      timeout,
    ),
  )
  try {
    await code
    const bytes = Buffer.concat(chunks)
    if (!bytes.length || bytes.length > 4096) throw new Error("Private pipe secret payload incomplete")
    const result = new TextDecoder("utf8", { fatal: true }).decode(bytes)
    bytes.fill(0)
    return result
  } finally {
    for (const part of chunks) part.fill(0)
  }
}
