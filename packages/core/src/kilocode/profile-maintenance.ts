import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { readdir, readFile, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "../util/flock"
import { Hash } from "../util/hash"
import { resolve, type Input } from "./database-path"

type Writer = "profile.sqlite.primary.effect" | "profile.sqlite.primary.legacy" | "profile.storage.json"
type Root = { kind: "sqlite" | "json"; path: string }
type Scope = { version: 1; id: string; roots: readonly Root[] }
type Options = { signal?: AbortSignal; timeoutMs?: number }

function normalize(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value
}

async function canonical(file: string): Promise<string> {
  return realpath(file).catch(async (error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(await canonical(parent), path.basename(file))
  })
}

/** Resolve only explicit profile roots; never initialize Global, SQLite or AppRuntime. */
export async function profileScope(input: Input & { storage?: string }): Promise<Scope> {
  const file = resolve(input)
  if (file === ":memory:") throw new Error("An in-memory database has no portable profile root")
  const database = await canonical(path.resolve(file))
  const storage = await canonical(path.resolve(input.storage ?? path.join(input.data, "storage")))
  const info = await stat(storage).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
    return undefined
  })
  if (info && !info.isDirectory()) throw new Error("Profile JSON storage root is not a directory")
  const roots: Root[] = [
    { kind: "sqlite", path: database },
    { kind: "json", path: storage },
  ]
  roots.sort((left, right) => {
    const a = normalize(left.path)
    const b = normalize(right.path)
    return a < b ? -1 : a > b ? 1 : 0
  })
  const id = createHash("sha256")
    .update(JSON.stringify(roots.map((root) => ({ ...root, path: normalize(root.path) }))))
    .digest("hex")
  return { version: 1, id, roots }
}

function boundary(root: Root) {
  return {
    key: `raya.profile.${root.kind}:${normalize(root.path)}`,
    dir: path.join(path.dirname(root.path), ".raya-profile-locks"),
  }
}

function files(root: Root) {
  const lock = boundary(root)
  return {
    gate: path.join(lock.dir, Hash.fast(lock.key) + ".lock"),
    writers: path.join(lock.dir, Hash.fast(lock.key) + ".writers"),
  }
}

/** Shared native operation admission. A maintenance gate excludes new effects, not ordinary WAL peers. */
export function admitProfileOperation(root: Root) {
  if (!path.isAbsolute(root.path)) throw new Error("Profile writer root must be absolute")
  const file = (() => {
    const resolve = (file: string): string => {
      if (existsSync(file)) return realpathSync(file)
      const parent = path.dirname(file)
      if (parent === file) return realpathSync(file)
      return path.join(resolve(parent), path.basename(file))
    }
    return resolve(root.path)
  })()
  const names = files({ ...root, path: file })
  if (existsSync(names.gate)) throw new Error("Profile maintenance excludes this profile operation")
  mkdirSync(names.writers, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const marker = path.join(names.writers, token + ".json")
  const record = JSON.stringify({ pid: process.pid, hostname: os.hostname(), token })
  writeFileSync(marker, record, {
    flag: "wx",
    mode: 0o600,
  })
  if (existsSync(names.gate)) {
    unlinkSync(marker)
    throw new Error("Profile maintenance excludes this profile operation")
  }
  return {
    release: () => {
      if (readFileSync(marker, "utf8") !== record)
        throw new Error("Refusing to release changed profile operation ownership")
      unlinkSync(marker)
    },
  }
}

async function drain(root: Root, stop: number, signal?: AbortSignal) {
  const names = files(root)
  while (true) {
    signal?.throwIfAborted()
    const active = await readdir(names.writers).catch((error: unknown) => {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      return []
    })
    if (active.length === 0) return
    for (const name of active) {
      const file = path.join(names.writers, name)
      const raw = await readFile(file, "utf8").catch(() => undefined)
      if (!raw) continue
      const owner: unknown = (() => {
        try {
          return JSON.parse(raw)
        } catch {
          return undefined
        }
      })()
      if (
        !owner ||
        typeof owner !== "object" ||
        !("hostname" in owner) ||
        owner.hostname !== os.hostname() ||
        !("pid" in owner) ||
        typeof owner.pid !== "number" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        !("token" in owner) ||
        typeof owner.token !== "string" ||
        `${owner.token}.json` !== name
      )
        continue
      const dead = (() => {
        try {
          process.kill(owner.pid, 0)
          return false
        } catch (error) {
          return !!error && typeof error === "object" && "code" in error && error.code === "ESRCH"
        }
      })()
      if (!dead || (await readFile(file, "utf8").catch(() => undefined)) !== raw) continue
      await unlink(file).catch((error: unknown) => {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
      })
    }
    if (performance.now() >= stop) throw new Error("Profile maintenance timed out draining active profile operations")
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, stop - performance.now()))))
  }
}

/** Admit one actual writer root without initializing a profile or SQLite client. */
export async function resolveProfileRoot(root: Root) {
  if (!path.isAbsolute(root.path)) throw new Error("Profile writer root must be absolute")
  const file = await canonical(root.path)
  return { ...root, path: file, id: boundary({ ...root, path: file }).key }
}

export async function acquireProfileRoot(root: Root, options: Options = {}) {
  const timeout = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
    throw new Error("Profile maintenance admission deadline is invalid")
  const resolved = await resolveProfileRoot(root)
  const stop = performance.now() + timeout
  while (true) {
    options.signal?.throwIfAborted()
    const lease = (() => {
      try {
        return admitProfileOperation(resolved)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("maintenance excludes")) throw error
        return undefined
      }
    })()
    if (lease) {
      const release = async () => lease.release()
      return { id: resolved.id, release, finish: lease.release, [Symbol.asyncDispose]: release }
    }
    if (performance.now() >= stop) throw new Error("Timed out waiting for profile maintenance")
    const lock = boundary(resolved)
    const gate = await Flock.acquire(lock.key, {
      ...options,
      dir: lock.dir,
      timeoutMs: Math.max(1, stop - performance.now()),
      recover: "dead",
    })
    await gate.release()
  }
}

async function hold<T>(roots: readonly Root[], body: () => Promise<T>, options: Options) {
  const timeout = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
    throw new Error("Profile maintenance admission deadline is invalid")
  const started = performance.now()
  const enter = async (index: number): Promise<T> => {
    options.signal?.throwIfAborted()
    if (index === roots.length) {
      const result = await body()
      options.signal?.throwIfAborted()
      return result
    }
    const remaining = Math.floor(timeout - (performance.now() - started))
    if (remaining <= 0) throw new Error("Profile maintenance admission deadline elapsed")
    const lock = boundary(roots[index])
    return Flock.withLock(
      lock.key,
      async () => {
        await drain(roots[index], started + timeout, options.signal)
        return enter(index + 1)
      },
      {
        ...options,
        dir: lock.dir,
        timeoutMs: remaining,
        recover: "dead",
      },
    )
  }
  return enter(0)
}

/** Only participating builds coordinate here; excluded and older writers need separate quiescence proof. */
export function admitProfileWriter<T>(scope: Scope, writer: Writer, body: () => Promise<T>, options: Options = {}) {
  const kind = writer === "profile.storage.json" ? "json" : "sqlite"
  if (!["profile.storage.json", "profile.sqlite.primary.effect", "profile.sqlite.primary.legacy"].includes(writer))
    throw new Error("Unknown profile writer admission")
  const roots = scope.roots.filter((root) => root.kind === kind)
  if (roots.length !== 1) throw new Error("Profile writer root is unavailable")
  return hold(roots, body, options)
}

/** Experimental coordination only: admission is bounded, callback settlement is not. */
export function coordinateProfileWriters<T>(
  scope: Scope,
  intent: "cooperative-maintenance" | "portable-capture",
  body: () => Promise<T>,
  options: Options = {},
) {
  if (intent !== "cooperative-maintenance")
    throw new Error("Portable capture requires complete profile writer coverage; cooperative admission is insufficient")
  if (scope.roots.length !== 2 || new Set(scope.roots.map((root) => root.kind)).size !== 2)
    throw new Error("Profile maintenance roots are incomplete")
  return hold(
    scope.roots,
    async () => ({
      value: await body(),
      admission: {
        format: "raya.profile-maintenance",
        version: 1,
        scope: scope.id,
        cooperativeOnly: true,
        completeProfileCoverage: false,
        portableCaptureAuthorized: false,
      },
    }),
    options,
  )
}
