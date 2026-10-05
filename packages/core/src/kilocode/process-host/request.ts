import { spawn } from "node:child_process"

/** Reject late native replies even when timer callbacks are delayed. Never retry effects. */
export function request(file: string, args: string[], bound = 8 * 1024 * 1024, timeout = 15_000) {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 8 * 1024 * 1024)
    return Promise.reject(new Error("Invalid native response bound"))
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000)
    return Promise.reject(new Error("Invalid native request deadline"))
  const started = performance.now()
  return new Promise<unknown>((resolve, reject) => {
    let size = 0
    let stderr = 0
    let closed = false
    let code: number | null = null
    const streams = { stdout: false, stderr: false }
    const eof = { stdout: false, stderr: false }
    const errors: Error[] = []
    const chunks: Buffer[] = []
    const refuse = (err: Error) => {
      errors.push(err)
      chunks.length = 0
    }
    const expired = () => performance.now() - started >= timeout
    const finish = () => {
      if (!closed || !streams.stdout || !streams.stderr) return
      clearTimeout(timer)
      if (expired() && !errors.some((err) => err.message === "Native process host request timed out"))
        refuse(new Error("Native process host request timed out"))
      if (code !== 0) refuse(new Error("Native process ownership could not be verified"))
      if (!eof.stdout || !eof.stderr) refuse(new Error("Native process host streams did not reach EOF"))
      if (errors.length) {
        reject(errors.length === 1 ? errors[0] : new AggregateError(errors, "Native process host request failed"))
        return
      }
      try {
        resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))))
      } catch {
        reject(new Error("Native process host response invalid"))
      } finally {
        chunks.length = 0
      }
    }
    // A deadline refuses the reply but never releases the original process or its readers.
    const timer = setTimeout(() => refuse(new Error("Native process host request timed out")), timeout)
    void Promise.resolve().then(() => {
      if (expired() || errors.length) {
        clearTimeout(timer)
        reject(new Error("Native process host request timed out"))
        return
      }
      try {
        const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
        child.stdout.on("data", (chunk: Buffer) => {
          if (errors.length) return // Continue draining the original stream without retaining more bytes.
          size += chunk.length
          if (size > bound) {
            refuse(new Error("Native process host response exceeded bound"))
            return
          }
          chunks.push(chunk)
        })
        child.stderr.on("data", (chunk: Buffer) => {
          if (errors.length) return
          stderr += chunk.length
          if (stderr > bound) refuse(new Error("Native process host response exceeded bound"))
        })
        for (const name of ["stdout", "stderr"] as const) {
          child[name].once("error", (err) => refuse(err))
          child[name].once("end", () => {
            eof[name] = true
          })
          child[name].once("close", () => {
            streams[name] = true
            finish()
          })
        }
        child.once("error", (err) => refuse(err))
        child.once("close", (value) => {
          code = value
          closed = true
          finish()
        })
      } catch (err) {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error("Native process host request failed"))
      }
    })
  })
}
