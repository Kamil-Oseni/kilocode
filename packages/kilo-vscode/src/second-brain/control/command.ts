import type { SpawnOptions } from "node:child_process"
import { spawn } from "../../util/process"

/** A deadline fences acceptance; the original child and both readers still join naturally. */
export async function command(file: string, args: string[], opts: SpawnOptions, timeout = 15000, bound = 65536) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000)
    throw new Error("Invalid Memory helper observation deadline")
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 65536) throw new Error("Invalid Memory helper stream bound")
  const started = performance.now()
  const errors: Error[] = []
  const child = spawn(file, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  const counts = { stdout: 0, stderr: 0 }
  const eof = { stdout: false, stderr: false }
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
  const state = { expired: false }
  const expire = () => {
    if (state.expired) return
    state.expired = true
    errors.push(new Error("Memory helper observation expired; original lifetime remains held"))
  }
  const timer = setTimeout(expire, timeout)
  child.on("error", (err) => errors.push(err))
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      if (performance.now() - started >= timeout) expire()
      resolve({ code, signal })
    })
    child.once("close", (code, signal) => {
      if (!child.pid) resolve({ code, signal })
    })
  })
  const readers = (name: "stdout" | "stderr") =>
    new Promise<void>((resolve) => {
      const stream = child[name]!
      stream.on("error", (err) => errors.push(err))
      stream.on("data", (raw: Buffer) => {
        const prior = counts[name]
        counts[name] += raw.length
        if (prior <= bound && counts[name] > bound)
          errors.push(new Error("Memory helper " + name + " exceeded observation bound"))
        const remaining = bound - prior
        if (remaining > 0) chunks[name].push(raw.subarray(0, remaining))
      })
      stream.once("end", () => {
        eof[name] = true
      })
      stream.once("close", () => resolve())
    })
  const pending = [readers("stdout"), readers("stderr")]
  const [result] = await Promise.all([exit, closed, ...pending])
  clearTimeout(timer)
  if (performance.now() - started >= timeout) expire()
  if (result.code !== 0 || result.signal !== null || !eof.stdout || !eof.stderr)
    errors.push(new Error("Memory helper original exit or stream EOF refused"))
  const receipt = Object.freeze({
    pid: child.pid ?? null,
    ...result,
    stdoutEOF: eof.stdout,
    stderrEOF: eof.stderr,
    stdoutBytes: counts.stdout,
    stderrBytes: counts.stderr,
    originalJoined: true,
    readersJoined: true,
    observationExpired: state.expired,
    forced: false,
  })
  if (errors.length)
    throw Object.assign(new AggregateError(errors, "Memory helper failures retained after original joins"), { receipt })
  return {
    stdout: Buffer.concat(chunks.stdout).toString("utf8"),
    stderr: Buffer.concat(chunks.stderr).toString("utf8"),
    receipt,
  }
}
