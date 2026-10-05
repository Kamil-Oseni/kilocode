import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"
import { observe } from "@opencode-ai/core/kilocode/source-observer"

const schema = z
  .object({ status: z.literal("owned"), birth: z.string().regex(/^\d{1,20}$/), parent: z.number().int().nonnegative() })
  .strict()

export class TaskGone extends Error {
  constructor() {
    super("Run task process ended before native binding")
  }
}

function owned(value: unknown) {
  if (value && typeof value === "object" && "status" in value && value.status === "gone") throw new TaskGone()
  return schema.parse(value)
}

async function image(file: string) {
  const executable = await realpath(file)
  const info = await lstat(executable)
  if (!info.isFile() || info.size <= 0 || info.size > 256 * 1024 * 1024)
    throw new Error("Run task native image refused")
  return {
    executable,
    digest: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
  }
}

/** Bind only the PID reported by the exact VS Code TaskExecution. */
export async function bindTask(pid: number, file: string) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff || process.platform !== "win32")
    throw new Error("Run task native identity refused")
  const helper = await image(file)
  const manifest = path.join(path.dirname(helper.executable), "raya-process-host.json")
  const info = await lstat(manifest)
  if (!info.isFile() || info.size > 65536) throw new Error("Run task packaged helper refused")
  const meta: unknown = JSON.parse(await readFile(manifest, "utf8"))
  if (
    !meta ||
    typeof meta !== "object" ||
    !("version" in meta) ||
    meta.version !== 1 ||
    !("exe" in meta) ||
    meta.exe !== helper.digest
  )
    throw new Error("Run task packaged helper refused")
  const first = owned(await NativeProcess.inspect(pid, helper.executable))
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(-not $p){throw 'Task image absent'}; $p.ExecutablePath | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  const chunks: Buffer[] = []
  let size = 0
  child.stdout.on("data", (bytes: Buffer) => {
    size += bytes.length
    if (size > 65536) child.kill()
    else chunks.push(bytes)
  })
  child.stderr.resume()
  const timer = setTimeout(() => child.kill(), 10000)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  }).finally(() => clearTimeout(timer))
  if (code !== 0 || size > 65536) {
    owned(await NativeProcess.inspect(pid, helper.executable))
    throw new Error("Run task native image query refused")
  }
  const executable = z
    .string()
    .min(1)
    .max(32768)
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  if (!path.isAbsolute(executable)) throw new Error("Run task native image refused")
  const target = await image(executable)
  const last = owned(await NativeProcess.inspect(pid, helper.executable))
  if (first.birth !== last.birth) throw new Error("Run task native birth changed")
  const identity = Object.freeze({ pid, birth: first.birth, ...target })
  let stopping: Promise<number> | undefined
  return Object.freeze({
    identity,
    stop(terminate: () => void, signal?: AbortSignal) {
      if (stopping) return stopping
      stopping = (async () => {
        if (signal?.aborted) throw new Error("Run task native stop expired")
        const current = await image(identity.executable)
        if (current.digest !== identity.digest) throw new Error("Run task native image changed")
        const watcher = observe({ ...identity, timeout: 10000 })
        let closing: Promise<void> | undefined
        let failure: unknown
        const close = () => (closing ??= watcher.close())
        const abort = () => {
          void close().catch((err: unknown) => {
            failure ??= err
          })
        }
        signal?.addEventListener("abort", abort, { once: true })
        try {
          if (signal?.aborted) throw new Error("Run task native stop expired")
          await watcher.ready
          if (signal?.aborted) throw new Error("Run task native stop expired")
          terminate()
          return await watcher.done
        } finally {
          signal?.removeEventListener("abort", abort)
          await close()
          if (failure) throw failure
        }
      })()
      return stopping
    },
  })
}

export type NativeTask = Awaited<ReturnType<typeof bindTask>>
