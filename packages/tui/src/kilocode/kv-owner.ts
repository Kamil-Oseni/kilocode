import path from "node:path"
import { realpathSync } from "node:fs"
import { Flock } from "@opencode-ai/core/util/flock"
import { admitProfileOperation } from "@opencode-ai/core/kilocode/profile-maintenance"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { readJson, writeJsonAtomic } from "../util/persistence"

function canonical(file: string): string {
  try {
    return realpathSync(file)
  } catch (err) {
    if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
    const parent = path.dirname(file)
    if (parent === file) throw err
    return path.join(canonical(parent), path.basename(file))
  }
}

/** One realized TUI preference writer; this is not complete profile admission. */
export function kvOwner(input: string, registry = RuntimeRegistry) {
  registry.check()
  if (!path.isAbsolute(input)) throw new Error("TUI KV path must be absolute")
  const file = canonical(input)
  const root = { kind: "json" as const, path: path.dirname(file) }
  const lock = `tui-kv:${file}`
  const errors: unknown[] = []
  let closed = false
  let tail = Promise.resolve()
  let closing: Promise<void> | undefined
  const check = () => {
    registry.check()
    if (closed) throw new Error("TUI KV writer is retired")
  }
  const run = <T>(work: () => Promise<T>) => {
    check()
    // Accepted queued operations own a lease before waiting behind any earlier write.
    const lease = admitProfileOperation(root)
    const task = tail.then(async () => {
      const result = await Flock.withLock(lock, work, { dir: path.join(root.path, "locks") }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      )
      try {
        lease.release()
      } catch (err) {
        throw new AggregateError(
          [...(result.status === "rejected" ? [result.reason] : []), err],
          "TUI KV operation and lease release failed",
        )
      }
      if (result.status === "rejected") throw result.reason
      return result.value
    })
    tail = task.then(
      () => undefined,
      (err) => {
        errors.push(err)
      },
    )
    return task
  }
  const retire = () => {
    if (closing) return closing
    closed = true
    closing = tail.then(() => {
      if (errors.length) throw new AggregateError(errors, "TUI KV retirement failed")
    })
    return closing
  }
  registry.register(retire)
  return {
    check,
    retire,
    read: () =>
      run(() =>
        readJson<Record<string, unknown>>(file).catch((err: unknown) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
          throw err
        }),
      ),
    write(value: unknown) {
      const snapshot = structuredClone(value)
      return run(() => writeJsonAtomic(file, snapshot))
    },
  }
}
