import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { open, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bundled = import.meta.url.includes("$bunfs") || /[\\/]~BUN[\\/]/.test(import.meta.url)
const directory = bundled
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../native/kilocode/bin")
const executable = path.join(directory, "raya-process-host.exe")
let verified: { identity: string; pending: Promise<string> } | undefined

/** Compiled hosts declare compatibility explicitly; a failed native host never falls back. */
export function mode(): "native" | "legacy" {
  if (!bundled) return "native"
  const file = path.join(directory, "raya-process-mode.json")
  if (statSync(file).size > 4096) throw new Error("Native process capability declaration exceeded bound")
  const value: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("mode" in value) ||
    (value.mode !== "native" && value.mode !== "legacy")
  )
    throw new Error("Native process capability declaration invalid")
  return value.mode
}

function host() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Native process host platform unsupported")
  const file = statSync(executable)
  if (!file.isFile() || file.size <= 0 || file.size > 16 * 1024 * 1024)
    throw new Error("Native process host executable invalid")
  const identity = [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(":")
  return { file: executable, identity }
}

async function ready() {
  const candidate = host()
  if (verified?.identity !== candidate.identity) {
    verified = {
      identity: candidate.identity,
      pending: request(candidate.file, ["--protocol"], 4096).then((value) => {
        compatible(value)
        if (host().identity !== candidate.identity) throw new Error("Native process host changed during admission")
        return candidate.file
      }),
    }
  }
  const file = await verified.pending
  if (host().identity !== candidate.identity) throw new Error("Native process host changed during admission")
  return file
}

function compatible(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("proof" in value) ||
    value.proof !== "windows-job" ||
    !("architecture" in value) ||
    value.architecture !== "x64"
  )
    throw new Error("Native process host protocol invalid")
}

function pid(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) throw new Error("Invalid process identity")
  return String(value)
}

function birth(value: string) {
  if (!/^\d{1,20}$/.test(value) || BigInt(value) === 0n || BigInt(value) > 0xffffffffffffffffn)
    throw new Error("Invalid process birth identity")
  return value
}

async function request(file: string, args: string[], bound = 8 * 1024 * 1024) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    let error: Error | undefined
    const timer = setTimeout(() => {
      error = new Error("Native process host request timed out")
      child.kill()
    }, 15000)
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > bound) {
        error = new Error("Native process host response exceeded bound")
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (error || code !== 0) return reject(error ?? new Error("Native process ownership could not be verified"))
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (err) {
        reject(err)
      }
    })
  })
}

async function call(args: string[]) {
  return request(await ready(), args)
}

export function inspect(value: number) {
  return call(["inspect", pid(value)])
}

export function terminate(value: number, expected: string) {
  return call(["terminate", pid(value), birth(expected)])
}

export function query() {
  return call(["query"])
}

export function protocol() {
  return call(["--protocol"])
}

/** Validate a native candidate before admitting even the private gated shell. */
export async function check() {
  if (mode() === "legacy") return
  await ready()
}

export async function guard(input: {
  pid: number
  birth: string
  controller: number
  parentBirth: string
  control: string
  token: string
}): Promise<ChildProcess> {
  if (!/^[a-f0-9-]{36}$/.test(input.token) || !path.isAbsolute(input.control))
    throw new Error("Invalid native job owner")
  return spawn(
    await ready(),
    [
      "guard",
      pid(input.pid),
      birth(input.birth),
      pid(input.controller),
      birth(input.parentBirth),
      input.control,
      input.token,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  )
}

/** This opt-in primitive does not grant session authority or integrate the core PTY registry. */
export async function prepare(input: {
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  controller: number
  birth: string
  control: string
  token: string
  timeout?: number
}) {
  if (mode() !== "native") throw new Error("Contained PTY launch requires a native capability")
  if (
    !path.isAbsolute(input.command) ||
    !path.isAbsolute(input.cwd) ||
    !path.isAbsolute(input.control) ||
    !/^[a-f0-9-]{36}$/.test(input.token) ||
    input.args.length > 128 ||
    !(await stat(input.cwd)).isDirectory()
  )
    throw new Error("Contained PTY launch target invalid")
  const chunks: Buffer[] = []
  let size = 0
  const integer = (value: number) => {
    size += 4
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value)
    chunks.push(buffer)
  }
  const text = (value: string) => {
    if (value.includes("\0") || value.length > 6144 || size + 4 + value.length * 2 > 12288)
      throw new Error("Contained PTY launch field invalid or oversized")
    integer(value.length)
    size += value.length * 2
    chunks.push(Buffer.from(value, "utf16le"))
  }
  integer(1)
  const timeout = input.timeout ?? 60000
  if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 60000)
    throw new Error("Contained PTY launch admission deadline invalid")
  integer(timeout)
  text(input.command)
  text(input.cwd)
  integer(input.args.length)
  for (const value of input.args) text(value)
  const packet = Buffer.concat(chunks)
  if (packet.length > 12288) throw new Error("Contained PTY launch envelope exceeds bound")
  const capability = await call(["--launch-protocol"])
  if (
    typeof capability !== "object" ||
    capability === null ||
    !("version" in capability) ||
    capability.version !== 1 ||
    !("operation" in capability) ||
    capability.operation !== "pty-launch" ||
    !("proof" in capability) ||
    capability.proof !== "windows-job" ||
    Object.keys(capability).length !== 3
  )
    throw new Error("Contained PTY launch capability unavailable")
  return {
    command: await ready(),
    args: ["pty-launch", pid(input.controller), birth(input.birth), input.control, input.token],
    cwd: input.cwd,
    env: { ...input.env, RAYA_PTY_LAUNCH: packet.toString("base64") },
  }
}

/** Read exact suspended identity; a caller must save its authority/occupancy before resume. */
export async function suspended(control: string, token: string) {
  if (!path.isAbsolute(control) || !/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid native launch owner")
  const file = await open(`${control}.launch`, "r")
  try {
    const buffer = Buffer.alloc(4097)
    const result = await file.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > 4096) throw new Error("Native launch identity exceeds bound")
    const value: unknown = JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8"))
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("token" in value) ||
      value.token !== token ||
      !("proof" in value) ||
      value.proof !== "windows-job" ||
      !("state" in value) ||
      value.state !== "suspended" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !("birth" in value) ||
      typeof value.birth !== "string" ||
      !("helper" in value) ||
      typeof value.helper !== "number" ||
      !("helperBirth" in value) ||
      typeof value.helperBirth !== "string" ||
      Object.keys(value).length !== 8
    )
      throw new Error("Native launch identity invalid")
    pid(value.pid)
    pid(value.helper)
    birth(value.birth)
    birth(value.helperBirth)
    const job = await open(`${control}.job`, "r")
    try {
      const record = Buffer.alloc(4097)
      const read = await job.read(record, 0, record.length, 0)
      if (read.bytesRead > 4096) throw new Error("Native job identity exceeds bound")
      const assigned: unknown = JSON.parse(record.subarray(0, read.bytesRead).toString("utf8"))
      if (
        typeof assigned !== "object" ||
        assigned === null ||
        !("version" in assigned) ||
        assigned.version !== 2 ||
        !("token" in assigned) ||
        assigned.token !== token ||
        !("proof" in assigned) ||
        assigned.proof !== "windows-job" ||
        !("assigned" in assigned) ||
        assigned.assigned !== true ||
        Object.keys(assigned).length !== 4
      )
        throw new Error("Native launch job identity invalid")
    } finally {
      await job.close()
    }
    return { pid: value.pid, birth: value.birth, helper: value.helper, helperBirth: value.helperBirth }
  } finally {
    await file.close()
  }
}

/** Exclusive admission refuses a duplicate/unknown dispatch rather than replaying it. */
export async function resume(
  control: string,
  token: string,
  expected: { pid: number; birth: string; helper: number; helperBirth: string },
) {
  const identity = await suspended(control, token)
  if (
    identity.pid !== expected.pid ||
    identity.birth !== expected.birth ||
    identity.helper !== expected.helper ||
    identity.helperBirth !== expected.helperBirth
  )
    throw new Error("Native saved launch identity changed")
  const owners = await Promise.all([inspect(identity.pid), inspect(identity.helper)])
  for (const [index, value] of owners.entries())
    if (
      typeof value !== "object" ||
      value === null ||
      !("status" in value) ||
      value.status !== "owned" ||
      !("birth" in value) ||
      value.birth !== (index === 0 ? identity.birth : identity.helperBirth)
    )
      throw new Error("Native launch owner changed")
  const target = owners[0]
  if (typeof target !== "object" || target === null || !("parent" in target) || target.parent !== identity.helper)
    throw new Error("Native launch parent changed")
  await writeFile(
    `${control}.go`,
    JSON.stringify({ version: 1, token, pid: identity.pid, birth: identity.birth, action: "resume" }),
    { flag: "wx", mode: 0o600 },
  )
}

export * as NativeProcess from "./index"
