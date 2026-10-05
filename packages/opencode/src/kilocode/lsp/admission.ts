import path from "node:path"
import { lstat } from "node:fs/promises"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  resolveProfileRoot,
} from "@opencode-ai/core/kilocode/profile-maintenance"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { Flock } from "@opencode-ai/core/util/flock"
import type { Lifetime } from "./process"

/** Always run cleanup, preserving the original and finalizer failures. */
export async function settle<A>(body: () => Promise<A>, cleanup: () => Promise<void>) {
  const result = await Promise.allSettled([Promise.resolve().then(body)])
  const final = await Promise.allSettled([Promise.resolve().then(cleanup)])
  const errors = [...result, ...final].flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
  if (errors.length) throw new AggregateError(errors, "Language-server operation and cleanup failed")
  const row = result[0]
  if (row.status !== "fulfilled") throw new Error("Missing language-server result")
  return row.value
}

export function create(
  registry = RuntimeRegistry,
  register = registerProcessProfile,
  timeout = 180_000,
  shutdown = timeout,
) {
  const starts = new Set<Promise<unknown>>()
  const owners = new Set<{ retire(): Promise<void>; joined: Promise<void> }>()
  const errors: unknown[] = []
  let installed = false
  let fenced = false
  let closing: Promise<void> | undefined
  const drain = () => {
    fenced = true
    if (closing) return closing
    closing = (async () => {
      await Promise.allSettled(starts)
      const results = await Promise.allSettled([...owners].map((owner) => owner.retire()))
      for (const row of results) if (row.status === "rejected") errors.push(row.reason)
      if (errors.length) throw new AggregateError(errors, "Language-server writer retirement failed")
    })()
    void closing.catch(() => undefined)
    return closing
  }
  const observe = <A>(original: Promise<A>, ms = timeout) =>
    new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error("Language-server observation expired; original ownership is retained")
        errors.push(err)
        fenced = true
        void drain().catch(() => undefined)
        reject(err)
      }, ms)
      void original.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err: unknown) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  const open = (
    selected: string,
    body: (root: string, scope: { check(): Promise<void>; cover(file: string): Promise<void> }) => Promise<Lifetime>,
  ) => {
    // Reserve before any asynchronous validation, lease, HTTP or filesystem effect.
    registry.check()
    if (fenced) throw new Error("Language-server writer intake is terminal")
    if (!path.isAbsolute(selected)) throw new Error("Language-server bin root must be absolute")
    if (!installed) {
      registry.register(drain)
      installed = true
    }
    const task = (async () => {
      const root = await resolveProfileRoot({ kind: "json", path: selected })
      const lease = await acquireProfileRoot(root)
      const covered = new Map<string, Awaited<ReturnType<typeof acquireCoveredProfileRoot>>>()
      const release = () =>
        settle(
          async () => {
            const results = await Promise.allSettled([...covered.values()].reverse().map((entry) => entry.release()))
            const failures = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []))
            if (failures.length) throw new AggregateError(failures, "Language-server covered cleanup failed")
          },
          () => lease.release(),
        )
      let transferred = false
      return settle(
        async () => {
          const pin = await lstat(root.path, { bigint: true })
          if (!pin.isDirectory() || pin.isSymbolicLink())
            throw new Error("Language-server bin is not an ordinary directory")
          const check = async () => {
            const current = await resolveProfileRoot({ kind: "json", path: selected })
            const info = await lstat(root.path, { bigint: true })
            if (
              current.id !== root.id ||
              !info.isDirectory() ||
              info.isSymbolicLink() ||
              info.dev !== pin.dev ||
              info.ino !== pin.ino
            )
              throw new Error("Language-server bin binding changed")
          }
          const cover = async (file: string) => {
            await check()
            if (covered.has(file)) return
            const entry = await acquireCoveredProfileRoot({ kind: "json", path: file }, lease)
            covered.set(file, entry)
            await check()
          }
          await cover(path.join(root.path, ".raya-lsp-locks"))
          const lock = await Flock.acquire(`lsp-bin:${root.id}`, {
            dir: path.join(root.path, ".raya-lsp-locks"),
            recover: "dead",
            timeoutMs: 30_000,
          })
          let runtime: Lifetime | undefined
          await settle(
            async () => {
              await check()
              register([root.path])
              runtime = await body(root.path, { check, cover })
            },
            () => settle(() => lock.release(), check),
          ).catch(async (err: unknown) => {
            if (!runtime) throw err
            return settle(
              async () => {
                throw err
              },
              () => runtime!.close(),
            )
          })
          if (!runtime) throw new Error("Missing language-server lifetime")
          const child = runtime
          let released: Promise<void> | undefined
          let stopping: Promise<void> | undefined
          const finish = () => {
            if (released) return released
            let complete = false
            released = settle(
              () => child.joined,
              () =>
                settle(check, async () => {
                  await release()
                  complete = true
                }),
            ).finally(() => {
              if (complete) owners.delete(owner)
            })
            void released.catch((err: unknown) => errors.push(err))
            return released
          }
          const stop = () => {
            if (stopping) return stopping
            stopping = settle(() => child.close(), finish)
            void stopping.catch((err: unknown) => errors.push(err))
            return stopping
          }
          const owner = {
            process: child.process,
            bind: (work: () => Promise<void>) => child.bind(work),
            get joined() {
              return finish()
            },
            close: () => observe(stop(), shutdown),
            retire: stop,
          }
          owners.add(owner)
          transferred = true
          void finish()
          void owner.joined.catch(() => undefined)
          return owner
        },
        async () => {
          if (!transferred) await release()
        },
      )
    })()
    starts.add(task)
    void task.then(
      () => starts.delete(task),
      (err: unknown) => {
        errors.push(err)
        starts.delete(task)
      },
    )
    return observe(task)
  }
  return {
    open,
    drain,
    snapshot: () => ({ installed, fenced, starts: starts.size, active: owners.size, failures: errors.length }),
  }
}

type Admission = ReturnType<typeof create>
const key = Symbol.for("raya.lsp.managed-writer.v1")
const shared = globalThis as typeof globalThis & { [key]?: Admission }
export const admission = (shared[key] ??= create())
export type Owner = Awaited<ReturnType<Admission["open"]>>
