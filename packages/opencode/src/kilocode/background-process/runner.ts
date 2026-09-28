import { KiloPtySelfCommand } from "@/kilocode/pty/self-command"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { mkdir, open, readFile, readdir, rm, stat } from "fs/promises"
import { spawn } from "child_process"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import * as WindowsTree from "./windows-tree"
import { guardian } from "./windows-job"
import { NativeProcess } from "@opencode-ai/core/kilocode/process-host/index"

export namespace BackgroundProcessRunner {
  const MARKER = "__background-process-runner"
  const MODE = 0o600
  const MAX = 1024 * 1024
  const KEEP = 200 * 1024

  export type Input = {
    token: string
    shell: string
    args: string[]
    cwd: string
    log: string
    control: string
    terminal?: boolean
    command?: string
  }

  export function sidecars(control: string) {
    return {
      probe: `${control}.probe`,
      ack: `${control}.ack`,
      ready: `${control}.ready`,
      go: `${control}.go`,
      job: `${control}.job`,
      drained: `${control}.drained`,
    }
  }

  function encode(input: Input) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  }

  function decode(input: string): Input {
    const value: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"))
    if (
      !isRecord(value) ||
      typeof value.token !== "string" ||
      typeof value.shell !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.log !== "string" ||
      typeof value.control !== "string" ||
      !Array.isArray(value.args)
    ) {
      throw new Error("Invalid background process runner input")
    }
    return {
      token: value.token,
      shell: value.shell,
      args: value.args.filter((item): item is string => typeof item === "string"),
      cwd: value.cwd,
      log: value.log,
      control: value.control,
      ...(value.terminal === true ? { terminal: true } : {}),
      ...(typeof value.command === "string" ? { command: value.command } : {}),
    }
  }

  export function command(input: Input) {
    const self = KiloPtySelfCommand.command()
    const source = path.basename(self.command).toLowerCase().includes("bun")
    const script = self.args.find((item) => /\.(ts|js|mjs|cjs)$/.test(item))
    const args =
      !source || path.basename(script ?? "") === "index.ts"
        ? self.args
        : [path.resolve(import.meta.dirname, "../../index.ts")]
    const cwd = source && self.cwd ? ["--cwd", self.cwd] : []
    return [self.command, ...cwd, ...args, MARKER, input.token, encode(input)]
  }

  async function writer(input: Input) {
    let file = await open(input.log, "a", MODE)
    let size = (await file.stat()).size
    let queue = Promise.resolve()
    const append = (chunk: Buffer) => {
      queue = queue.then(async () => {
        if (size + chunk.length <= MAX) {
          await file.write(chunk)
          size += chunk.length
        } else {
          await file.close()
          const source = Bun.file(input.log)
          const old = size
            ? Buffer.from(await source.slice(Math.max(0, size - KEEP), size).arrayBuffer())
            : Buffer.alloc(0)
          const next = Buffer.concat([old, chunk])
          const tail = next.subarray(Math.max(0, next.length - KEEP))
          await Filesystem.write(input.log, tail, MODE)
          file = await open(input.log, "a", MODE)
          size = tail.length
        }
        if (!process.stdout.destroyed) process.stdout.write(chunk)
      })
    }
    return {
      append,
      async close() {
        await queue
        await file.close()
      },
    }
  }

  // Linux scan is diagnostic only; it does not authorize a containment receipt.
  const GRACE = 1_000

  async function bounded(file: string, max: number) {
    const handle = await open(file, "r")
    try {
      const buffer = Buffer.alloc(max + 1)
      let size = 0
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size)
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size > max) throw new Error("Native process ownership response exceeded its limit")
      return buffer.subarray(0, size)
    } finally {
      await handle.close()
    }
  }

  export async function drained(control: string, token: string) {
    const source = await bounded(sidecars(control).drained, 4096)
    const value: unknown = JSON.parse(source.toString("utf8"))
    return (
      isRecord(value) &&
      value.version === 2 &&
      value.token === token &&
      value.proof === "windows-job" &&
      value.empty === true
    )
  }

  export async function ready(control: string, token: string) {
    const source = await bounded(sidecars(control).ready, 4096)
    const value: unknown = JSON.parse(source.toString("utf8"))
    return isRecord(value) && value.version === 1 && value.token === token
  }

  export async function contained(control: string, token: string) {
    const source = await bounded(sidecars(control).job, 4096)
    const value: unknown = JSON.parse(source.toString("utf8"))
    return (
      isRecord(value) &&
      value.version === 2 &&
      value.token === token &&
      value.proof === "windows-job" &&
      value.assigned === true
    )
  }

  function gate(input: Input) {
    if (input.command === undefined) return input.args
    const file = sidecars(input.control).go
    if (Shell.ps(input.shell))
      return Shell.args(
        input.shell,
        `while (!(Test-Path -LiteralPath '${file.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 50 }; ${input.command}`,
        input.cwd,
      )
    if (Shell.name(input.shell) === "cmd")
      throw new Error("Native supervised command gating is unavailable for this shell")
    return Shell.args(
      input.shell,
      `while [ ! -f '${file.replaceAll("'", "'\\''")}' ]; do sleep 0.05; done; ${input.command}`,
      input.cwd,
    )
  }

  async function linux(input: Input, root: number, seen: Map<number, string>, active: boolean) {
    const entries = await readdir("/proc")
    if (entries.length > 32_768) throw new Error("Native process ownership scan exceeded its limit")
    const rows: { pid: number; parent: number; group: number; birth: string; owned: boolean }[] = []
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue
      const file = `/proc/${name}`
      const source = await bounded(`${file}/stat`, 8192)
        .then((data) => data.toString("utf8"))
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT" || err.code === "ESRCH") return undefined
          throw err
        })
      if (!source) continue
      const match = source.match(/^\d+ \(.*\) ([A-Z]) (.*)$/)
      if (!match) throw new Error("Native process ownership response was incomplete")
      if (match[1] === "Z") continue
      const fields = match[2].split(" ")
      if (fields.length < 19) throw new Error("Native process ownership response was incomplete")
      const meta = await stat(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ESRCH") return undefined
        throw err
      })
      if (!meta) continue
      const owned =
        meta.uid === process.getuid?.() &&
        (await bounded(`${file}/environ`, MAX).then(
          (data) => {
            if (data.length > MAX) throw new Error("Native process ownership environment exceeded its limit")
            return data.includes(Buffer.from(`KILO_BACKGROUND_PROCESS_TOKEN=${input.token}\0`))
          },
          (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT" || err.code === "ESRCH") return false
            throw err
          },
        ))
      rows.push({ pid: Number(name), parent: Number(fields[0]), group: Number(fields[1]), birth: fields[18], owned })
    }
    const live = new Map(rows.map((row) => [row.pid, row.birth]))
    const next = new Map([...seen].filter(([pid, birth]) => live.get(pid) === birth))
    for (const row of rows)
      if (row.pid !== process.pid && (row.owned || row.group === process.pid)) next.set(row.pid, row.birth)
    const stack = [...(active ? [root] : []), ...next.keys()]
    while (stack.length) {
      const pid = stack.pop()
      for (const row of rows) {
        if (row.parent !== pid || row.pid === process.pid || next.has(row.pid)) continue
        next.set(row.pid, row.birth)
        stack.push(row.pid)
      }
    }
    return next
  }

  async function respond(control: string, signal: AbortSignal) {
    const files = sidecars(control)
    while (!signal.aborted) {
      const nonce = await readFile(files.probe, "utf8").catch(() => undefined)
      if (nonce) {
        await Filesystem.write(files.ack, nonce, MODE)
        await rm(files.probe, { force: true })
      }
      await Bun.sleep(50)
    }
  }

  async function windows(input: Input, child: ReturnType<typeof spawn>, done: Promise<number>) {
    if (!child.pid || input.command === undefined) throw new Error("Native containment requires a gated command")
    const owners = await Promise.all([WindowsTree.sample(child.pid), WindowsTree.sample(process.pid)])
    const root = owners[0]
    const parent = owners[1]
    if (root.status !== "owned" || !root.birth || parent.status !== "owned" || !parent.birth)
      throw new Error("Native containment owner could not be verified")
    const guard = await guardian({
      pid: child.pid,
      birth: root.birth,
      controller: process.pid,
      parentBirth: parent.birth,
      control: input.control,
      token: input.token,
    })
    let failure: Error | undefined
    let ended = false
    // Consume diagnostics without retaining command paths or private ownership tokens.
    guard.stderr?.resume()
    let opened = false
    const closed = new Promise<number>((resolve, reject) => {
      guard.once("error", (err) => {
        failure = err
        reject(err)
      })
      guard.once("exit", (code) => {
        ended = true
        resolve(code ?? 1)
      })
    })
    // Observe early rejection while assignment is pending without losing the original failure.
    void closed.catch((err: Error) => {
      failure = err
    })
    const abort = new AbortController()
    const response = respond(input.control, abort.signal)
    try {
      const deadline = performance.now() + 60000
      while (true) {
        if (failure || ended) throw new Error("Native containment guardian exited before admission")
        const source = await bounded(sidecars(input.control).job, 4096).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined
          throw err
        })
        if (source) {
          const value: unknown = JSON.parse(source.toString("utf8"))
          if (
            !isRecord(value) ||
            value.version !== 2 ||
            value.token !== input.token ||
            value.proof !== "windows-job" ||
            value.assigned !== true
          )
            throw new Error("Native containment receipt was invalid")
          break
        }
        if (performance.now() >= deadline) throw new Error("Native containment guardian did not admit the command")
        await Bun.sleep(50)
      }
      await Filesystem.writeJson(sidecars(input.control).ready, { version: 1, token: input.token }, MODE)
      await Filesystem.write(sidecars(input.control).go, "go", MODE)
      opened = true
      if ((await closed) !== 0 || !(await drained(input.control, input.token)))
        throw new Error("Native containment did not confirm actual drainage")
      return await done
    } catch (err) {
      if (!opened) {
        const result = await WindowsTree.terminate(child.pid, root.birth)
        if (result === "unknown" || result === "owned")
          throw new Error("Gated native command could not be safely terminated", { cause: err })
      }
      throw err
    } finally {
      abort.abort()
      await response
      if (!ended) guard.kill()
    }
  }

  async function supervise(input: Input, child: ReturnType<typeof spawn>, done: Promise<number>) {
    const pid = child.pid
    if (!pid) throw new Error("Background process runner child did not provide a pid")
    let code: number | undefined
    let exited: number | undefined
    let failure: unknown
    let seen = new Map<number, string>()
    const abort = new AbortController()
    const response = respond(input.control, abort.signal)
    let stopping = false
    let opened = false
    void done.then(
      (value) => {
        code = value
        exited = Date.now()
      },
      (err) => {
        failure = err
      },
    )
    try {
      while (true) {
        if (failure) throw failure
        const active = code === undefined || (exited !== undefined && Date.now() - exited < GRACE)
        seen = await linux(input, pid, seen, active)
        if (!opened) {
          if (code !== undefined) throw new Error("Native process owner exited before its birth could be verified")
          await Filesystem.writeJson(sidecars(input.control).ready, { version: 1, token: input.token }, MODE)
          await Filesystem.write(sidecars(input.control).go, "go", MODE)
          opened = true
        }
        stopping ||= await Bun.file(input.control).exists()
        if (stopping) throw new Error("Pinned descendant termination is unavailable on this platform")
        if (code !== undefined && !active && seen.size === 0) {
          return code
        }
        await Bun.sleep(100)
      }
    } finally {
      abort.abort()
      await response
    }
  }

  async function run(input: Input) {
    if (process.platform === "win32") await NativeProcess.check()
    process.stdout.on("error", () => process.stdout.destroy())
    await mkdir(path.dirname(input.log), { recursive: true, mode: 0o700 })
    const files = sidecars(input.control)
    await Promise.all([
      Filesystem.write(input.log, "", MODE),
      rm(input.control, { force: true }),
      rm(files.probe, { force: true }),
      rm(files.ack, { force: true }),
      rm(files.drained, { force: true }),
      rm(files.ready, { force: true }),
      rm(files.go, { force: true }),
      rm(files.job, { force: true }),
    ])
    const output = await writer(input)
    const child = spawn(input.shell, gate(input), {
      cwd: input.cwd,
      env: process.env,
      stdio: input.terminal ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    child.stdout?.on("data", output.append)
    child.stderr?.on("data", output.append)
    const done = new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    let code: number
    try {
      if (process.platform !== "win32" && process.platform !== "linux")
        throw new Error("Native process tree verification is unavailable on this platform")
      code = process.platform === "win32" ? await windows(input, child, done) : await supervise(input, child, done)
    } finally {
      await output.close()
    }
    return code
  }

  export async function maybe(argv = process.argv) {
    const index = argv.indexOf(MARKER)
    if (index < 0) return false
    const token = argv[index + 1]
    const value = argv[index + 2]
    if (!token || !value) throw new Error("Missing background process runner input")
    const input = decode(value)
    if (input.token !== token) throw new Error("Background process runner token mismatch")
    process.env.KILO_BACKGROUND_PROCESS_TOKEN = token
    process.exitCode = await run(input)
    return true
  }
}
