import path from "node:path"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"
import { binding, inspect, publish } from "@opencode-ai/core/kilocode/markdown-publication"
import { acquireProfileRoot, resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { Flock } from "@opencode-ai/core/util/flock"
import { KiloShutdown } from "./shutdown"

const pending = new Set<Promise<void>>()
const failures: unknown[] = []
let closing: Promise<void> | undefined
const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)

export namespace AgentPublication {
  export function drain() {
    return (closing ??= Promise.all(pending).then(() => {
      if (failures.length) throw new AggregateError(failures, "Agent publication retirement failed")
    }))
  }

  /** Admit the actual command's immutable Markdown; generation and interactive prompts remain outside this boundary. */
  export function save(directory: string, id: string, text: string): Promise<boolean> {
    if (closing) return Promise.reject(new Error("Agent publication is retired"))
    if (
      !path.isAbsolute(directory) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) ||
      Buffer.byteLength(text) > 1048576
    )
      return Promise.reject(new Error("Agent publication input is invalid"))
    const dir = path.resolve(directory)
    const root = path.dirname(dir)
    const target = path.join(dir, id + ".md")
    let owned = false
    const work = (async () => {
      const pins = new Map<string, { dev: bigint; ino: bigint }>()
      async function pin(file: string): Promise<void> {
        const stat = await lstat(file, { bigint: true }).catch((err: unknown) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
          throw err
        })
        if (!stat) {
          const parent = path.dirname(file)
          if (parent === file) throw new Error("Agent publication has no physical ancestor")
          return pin(parent)
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(file)) !== key(file))
          throw new Error("Agent publication directory is not canonical")
        const prior = pins.get(file)
        if (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino))
          throw new Error("Agent publication namespace changed")
        pins.set(file, { dev: stat.dev, ino: stat.ino })
      }
      await pin(root)
      await pin(dir)
      const roots = await Promise.all([root, dir].map((path) => resolveProfileRoot({ kind: "json", path })))
      if (roots.some((scope, index) => key(scope.path) !== key([root, dir][index])))
        throw new Error("Agent publication root is not canonical")
      const scopes = [...new Map(roots.map((scope) => [scope.id, scope])).values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      const leases: Awaited<ReturnType<typeof acquireProfileRoot>>[] = []
      const errors: unknown[] = []
      let lock: Awaited<ReturnType<typeof Flock.acquire>> | undefined
      let ticket: ReturnType<typeof ConfigIntent.reserveMarkdown> | undefined
      let created = false
      async function check() {
        for (const [file, expected] of pins) {
          const stat = await lstat(file, { bigint: true })
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.dev !== expected.dev ||
            stat.ino !== expected.ino ||
            key(await realpath(file)) !== key(file)
          )
            throw new Error("Agent publication namespace changed")
        }
        for (const scope of roots)
          if ((await resolveProfileRoot({ kind: "json", path: scope.path })).id !== scope.id)
            throw new Error("Agent publication admission changed")
      }
      try {
        owned = true
        for (const scope of scopes) {
          leases.push(await acquireProfileRoot(scope))
          await check()
        }
        registerProcessProfile(scopes.map((scope) => scope.path))
        await mkdir(dir, { recursive: true })
        await pin(root)
        await pin(dir)
        await check()
        const locks = path.join(root, ".agent-create-locks")
        await pin(locks)
        lock = await Flock.acquire("agent-create:" + key(target), { dir: locks, recover: false })
        await pin(locks)
        await check()
        const predecessor = await inspect(target)
        if (!binding(predecessor)) {
          ticket = ConfigIntent.reserveMarkdown(target)
          const before = await ticket.prepare(target)
          if (binding(before)) throw new Error("Agent appeared before create-only publication")
          await check()
          const receipt = await publish(target, text, before)
          await ticket.complete(receipt)
          created = true
        }
      } catch (err) {
        errors.push(err)
        ticket?.fail(err)
      } finally {
        if (lock)
          await lock.release().catch((err) => {
            errors.push(err)
          })
        await check().catch((err) => {
          errors.push(err)
        })
        for (const lease of leases.reverse())
          await lease.release().catch((err) => {
            errors.push(err)
          })
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Agent publication and cleanup failed")
      return created
    })()
    const settled = work.then(
      () => {
        pending.delete(settled)
      },
      (err) => {
        if (owned) failures.push(err)
        pending.delete(settled)
      },
    )
    pending.add(settled)
    return work
  }
}

KiloShutdown.register(AgentPublication.drain)
