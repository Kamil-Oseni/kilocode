import { spawn, type ChildProcess } from "node:child_process"

/** Reject late native replies even when timer callbacks are delayed. Never retry effects. */
export function request(file: string, args: string[], bound = 8 * 1024 * 1024, timeout = 15_000) {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 8 * 1024 * 1024)
    return Promise.reject(new Error("Invalid native response bound"))
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000)
    return Promise.reject(new Error("Invalid native request deadline"))
  const started = performance.now()
  return new Promise<unknown>((resolve, reject) => {
    let child: ChildProcess | undefined
    let settled = false
    let size = 0
    const chunks: Buffer[] = []
    const finish = (err?: Error, value?: unknown) => {
      if (settled) return
      const expired = performance.now() - started >= timeout
      settled = true
      clearTimeout(timer)
      chunks.length = 0
      if (err || expired) {
        child?.kill()
        reject(expired ? new Error("Native process host request timed out") : err)
        return
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(new Error("Native process host request timed out")), timeout)
    void Promise.resolve().then(() => {
      if (settled) return
      if (performance.now() - started >= timeout) {
        finish(new Error("Native process host request timed out"))
        return
      }
      try {
        child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
        child.stdout!.on("data", (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > bound) {
            finish(new Error("Native process host response exceeded bound"))
            return
          }
          chunks.push(chunk)
        })
        child.once("error", (err) => finish(err))
        child.once("close", (code) => {
          if (settled) return
          if (code !== 0) {
            finish(new Error("Native process ownership could not be verified"))
            return
          }
          try {
            finish(undefined, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))))
          } catch {
            finish(new Error("Native process host response invalid"))
          }
        })
      } catch (err) {
        finish(err instanceof Error ? err : new Error("Native process host request failed"))
      }
    })
  })
}
