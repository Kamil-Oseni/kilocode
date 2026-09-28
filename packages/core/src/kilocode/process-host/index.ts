import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { request } from "./request"
import { readFileSync, statSync } from "node:fs"
import { open, stat } from "node:fs/promises"
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

export function lifecycle() {
  return call(["--pty-lifecycle-protocol"])
}

export type Receipt = Readonly<{ version: 1; volume: string; index: string; digest: string; data: string }>

function snapshot(value: unknown): Receipt {
  const row = record(value, ["version", "volume", "index", "digest", "data"], "Native file receipt invalid")
  if (
    row.version !== 1 ||
    typeof row.volume !== "string" ||
    !/^\d{1,10}$/.test(row.volume) ||
    BigInt(row.volume) > 0xffffffffn ||
    typeof row.index !== "string" ||
    !/^\d{1,20}$/.test(row.index) ||
    BigInt(row.index) === 0n ||
    BigInt(row.index) > 0xffffffffffffffffn ||
    typeof row.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.digest) ||
    typeof row.data !== "string" ||
    row.data.length > 174_764 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data)
  )
    throw new Error("Native file receipt invalid")
  const bytes = Buffer.from(row.data, "base64")
  if (
    bytes.length > 131_072 ||
    bytes.toString("base64") !== row.data ||
    createHash("sha256").update(bytes).digest("hex") !== row.digest
  )
    throw new Error("Native file receipt content invalid")
  return Object.freeze({ version: 1, volume: row.volume, index: row.index, digest: row.digest, data: row.data })
}

function location(file: string) {
  if (!path.isAbsolute(file) || file.length > 4096 || file.includes("\0"))
    throw new Error("Native file receipt path invalid")
  return file
}

/** Private metadata snapshots never enter model context or telemetry. */
export async function receipt(file: string): Promise<Receipt | undefined> {
  const value = await request(await ready(), ["file-receipt-v1", location(file)], 196_608)
  if (typeof value === "object" && value !== null && "state" in value) {
    const row = record(value, ["version", "state"], "Native file receipt response invalid")
    if (row.version !== 1 || row.state !== "absent") throw new Error("Native file receipt response invalid")
    return undefined
  }
  return snapshot(value)
}

/** Exact handle deletion cannot remove a replacement after the snapshot check. */
export async function remove(file: string, expected: Receipt): Promise<void> {
  const saved = snapshot(expected)
  const value = await request(
    await ready(),
    ["file-remove-v1", location(file), saved.volume, saved.index, saved.digest],
    4096,
  )
  const row = record(value, ["version", "state"], "Native file removal response invalid")
  if (row.version !== 1 || (row.state !== "absent" && row.state !== "removed"))
    throw new Error("Native file removal response invalid")
}

/** Publish private metadata without replacing a destination or following a changed source. */
export async function move(file: string, expected: Receipt, target: string): Promise<void> {
  const saved = snapshot(expected)
  const value = await request(
    await ready(),
    ["file-move-v1", location(file), saved.volume, saved.index, saved.digest, location(target)],
    4096,
  )
  const row = record(value, ["version", "state"], "Native file publication response invalid")
  if (row.version !== 1 || row.state !== "moved") throw new Error("Native file publication response invalid")
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

function record(value: unknown, fields: readonly string[], message: string) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...fields].sort().join(",")
  )
    throw new Error(message)
  return value as Record<string, unknown>
}

function capability(value: unknown) {
  const row = record(value, ["version", "operation", "proof"], "Contained PTY launch capability unavailable")
  if (row.version !== 1 || row.operation !== "pty-launch" || row.proof !== "windows-job")
    throw new Error("Contained PTY launch capability unavailable")
}

function launch(value: unknown, token: string) {
  const row = record(
    value,
    ["version", "token", "proof", "state", "pid", "birth", "helper", "helperBirth"],
    "Native launch identity invalid",
  )
  if (row.version !== 1 || row.token !== token || row.proof !== "windows-job" || row.state !== "suspended")
    throw new Error("Native launch identity invalid")
  if (
    typeof row.pid !== "number" ||
    typeof row.birth !== "string" ||
    typeof row.helper !== "number" ||
    typeof row.helperBirth !== "string"
  )
    throw new Error("Native launch identity invalid")
  return { pid: row.pid, birth: row.birth, helper: row.helper, helperBirth: row.helperBirth }
}

function assignment(value: unknown, token: string) {
  const row = record(value, ["version", "token", "proof", "assigned"], "Native launch job identity invalid")
  if (row.version !== 2 || row.token !== token || row.proof !== "windows-job" || row.assigned !== true)
    throw new Error("Native launch job identity invalid")
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
  const capacity = await call(["--launch-protocol"])
  capability(capacity)
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
    const identity = launch(value, token)
    pid(identity.pid)
    pid(identity.helper)
    birth(identity.birth)
    birth(identity.helperBirth)
    const job = await open(`${control}.job`, "r")
    try {
      const record = Buffer.alloc(4097)
      const read = await job.read(record, 0, record.length, 0)
      if (read.bytesRead > 4096) throw new Error("Native job identity exceeds bound")
      const assigned: unknown = JSON.parse(record.subarray(0, read.bytesRead).toString("utf8"))
      assignment(assigned, token)
    } finally {
      await job.close()
    }
    return identity
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
  const temp = `${control}.go.tmp`
  const file = await open(temp, "wx", 0o600)
  try {
    await file.writeFile(
      JSON.stringify({ version: 1, token, pid: identity.pid, birth: identity.birth, action: "resume" }),
    )
    await file.sync()
  } finally {
    await file.close()
  }
  const saved = await receipt(temp)
  if (!saved) throw new Error("Native resume publication disappeared")
  await move(temp, saved, `${control}.go`)
}

export * as NativeProcess from "./index"
