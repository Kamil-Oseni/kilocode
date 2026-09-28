import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
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

export * as NativeProcess from "./index"
