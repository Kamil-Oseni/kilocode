import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { finished } from "node:stream/promises"

/** Observe the original handle and both pipes; a stop request or root exit is not this join. */
export function own(child: ChildProcessWithoutNullStreams) {
  const failures: unknown[] = []
  let closing: Promise<void> | undefined
  let shutdown: (() => Promise<void>) | undefined
  child.stdin.on("error", (err) => failures.push(err))
  const exited = new Promise<void>((resolve) => {
    child.once("error", (err) => failures.push(err))
    child.once("close", (code, signal) => {
      if (code !== 0) failures.push(new Error(`Language server closed with ${code ?? signal}`))
      resolve()
    })
  })
  const pipes = [child.stdout, child.stderr].map((stream) => finished(stream, { cleanup: true }))
  const ended = Promise.allSettled([exited, ...pipes]).then((results) => {
    for (const result of results) if (result.status === "rejected") failures.push(result.reason)
    if (failures.length) throw new AggregateError(failures, "Language-server process retirement failed")
  })
  const joined = Promise.allSettled([ended]).then(async (results) => {
    const final = closing ? await Promise.allSettled([closing]) : []
    const errors = [...results, ...final].flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Language-server original joins failed")
  })
  void ended.catch(() => undefined)
  void joined.catch(() => undefined)
  return {
    process: child,
    joined,
    bind(work: () => Promise<void>) {
      if (shutdown || closing) throw new Error("Language-server shutdown is already bound")
      shutdown = work
    },
    close() {
      if (closing) return closing
      closing = (async () => {
        const errors: unknown[] = []
        if (child.exitCode === null && child.signalCode === null && shutdown)
          await shutdown().catch((err: unknown) => errors.push(err))
        // EOF and original joins remain necessary after a rejected protocol request.
        child.stdout.resume()
        child.stderr.resume()
        if (!child.stdin.destroyed) child.stdin.end()
        await ended.catch((err: unknown) => errors.push(err))
        if (errors.length) throw new AggregateError(errors, "Language-server shutdown failed")
      })()
      void closing.catch(() => undefined)
      return closing
    },
  }
}

export type Lifetime = ReturnType<typeof own>

/** Bound retained diagnostics while continuing to drain an actual installer child. */
export async function command(child: ChildProcessWithoutNullStreams, limit = 1024 * 1024) {
  const owner = own(child)
  const errors: unknown[] = []
  const consume = async (stream: typeof child.stdout) => {
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk)
      if (bytes <= limit) chunks.push(Buffer.from(chunk))
      if (bytes > limit && bytes - Buffer.byteLength(chunk) <= limit)
        errors.push(new Error("Language-server installer output exceeds its bound"))
    }
    return Buffer.concat(chunks)
  }
  const tasks = [consume(child.stdout), consume(child.stderr)]
  child.stdin.end()
  const results = await Promise.allSettled([...tasks, owner.joined])
  for (const result of results) if (result.status === "rejected") errors.push(result.reason)
  if (errors.length) throw new AggregateError(errors, "Language-server installer failed")
  const output = results[0]
  if (output.status !== "fulfilled" || !Buffer.isBuffer(output.value)) throw new Error("Missing installer output")
  return output.value
}
