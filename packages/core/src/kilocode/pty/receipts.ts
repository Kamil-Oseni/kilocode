import { open } from "node:fs/promises"
import type { Proof, Identity } from "./lifecycle"

export type Result = { exitCode?: number; outcome: "confirmed" | "cancelled" | "unknown" }

export async function text(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined
    throw err
  })
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(4097)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead <= 0 || result.bytesRead > 4096) throw new Error("Native PTY receipt exceeded bound")
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, result.bytesRead))
  } finally {
    await handle.close()
  }
}

export async function read(file: string): Promise<unknown | undefined> {
  const value = await text(file)
  if (value === undefined) return undefined
  try {
    return JSON.parse(value)
  } catch {
    throw new Error("Native PTY receipt malformed")
  }
}

export function drained(value: unknown, token: string): value is Proof {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 4 &&
    "version" in value &&
    value.version === 2 &&
    "token" in value &&
    value.token === token &&
    "proof" in value &&
    value.proof === "windows-job" &&
    "empty" in value &&
    value.empty === true
  )
}

export function exited(value: unknown, token: string, identity?: Identity): Result {
  if (
    !identity ||
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 8 ||
    !("version" in value) ||
    value.version !== 1 ||
    !("token" in value) ||
    value.token !== token ||
    !("proof" in value) ||
    value.proof !== "windows-job" ||
    !("pid" in value) ||
    value.pid !== identity.pid ||
    !("birth" in value) ||
    value.birth !== identity.birth ||
    !("state" in value) ||
    value.state !== "exited" ||
    !("exitCode" in value) ||
    typeof value.exitCode !== "number" ||
    !Number.isInteger(value.exitCode) ||
    value.exitCode < 0 ||
    value.exitCode > 0xffffffff ||
    !("outcome" in value) ||
    (value.outcome !== "confirmed" && value.outcome !== "cancelled")
  )
    return { outcome: "unknown" }
  return { exitCode: value.exitCode, outcome: value.outcome }
}
