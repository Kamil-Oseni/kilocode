import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs"
import { lstat, realpath, stat } from "node:fs/promises"
import { mkdir, readdir, readFile, rmdir, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "../util/flock"
import { Hash } from "../util/hash"
import { resolve, type Input } from "./database-path"
import { ProfileRoots } from "./profile-roots"
import { publish } from "./profile-record"

type Writer = "profile.sqlite.primary.effect" | "profile.sqlite.primary.legacy" | "profile.storage.json"
// "json" is the legacy filesystem admission namespace, not a content format:
// admitted directories/files are opaque bytes; SQLite retains a distinct native namespace.
type Root = { kind: "sqlite" | "json"; path: string }
type Scope = { version: 1; id: string; roots: readonly Root[] }
type Options = { signal?: AbortSignal; timeoutMs?: number }
type Pin = { path: string; dev: bigint; ino: bigint; directory: boolean }
type Reference = { root: Root; dir: Pin; pin: Pin; record: string }
type Child = { done: Promise<void>; finish: () => void; error?: unknown }
type Owner = {
  root: Root
  selected: string
  history: Root
  pin?: Pin
  marker?: Pin
  children: Set<Child>
  cleanup: Map<string, { root: Root; pin?: Pin; refs: Set<Reference> }>
  count: number
  active: boolean
  closing: boolean
}
const owners = new WeakMap<object, Owner>()

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
    owners: path.join(lock.dir, Hash.fast(lock.key) + ".owners"),
  }
}

function resolved(root: Root) {
  if (!path.isAbsolute(root.path)) throw new Error("Profile writer root must be absolute")
  const canonical = (file: string): string => {
    if (existsSync(file)) return realpathSync(file)
    const parent = path.dirname(file)
    if (parent === file) return realpathSync(file)
    return path.join(canonical(parent), path.basename(file))
  }
  return { ...root, path: canonical(root.path) }
}

/** Lifetime ownership is separate from operation admission: idle native handles remain visible. */
export function registerProfileNative(root: Root) {
  if (root.kind !== "sqlite") throw new Error("Native profile ownership requires a SQLite root")
  return native(root)
}

/** A native file lifetime is distinct from each admitted write/cleanup operation. */
export function registerProfileFile(root: Root) {
  if (root.kind !== "json") throw new Error("Native file ownership requires a filesystem root")
  return native(root)
}

function native(root: Root) {
  const state = resolved(root)
  const names = files(state)
  if (existsSync(names.gate)) throw new Error("Profile maintenance excludes this native acquisition")
  mkdirSync(names.owners, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const marker = path.join(names.owners, token + ".json")
  const record = JSON.stringify({
    format: "raya.profile-native-owner",
    version: 1,
    root: normalize(state.path),
    pid: process.pid,
    hostname: os.hostname(),
    token,
  })
  publish(marker, record)
  if (existsSync(names.gate)) {
    unlinkSync(marker)
    throw new Error("Profile maintenance excludes this native acquisition")
  }
  ProfileRoots.register(state)
  let released = false
  return {
    path: state.path,
    release: () => {
      if (released) return
      if (readFileSync(marker, "utf8") !== record) throw new Error("Refusing to release changed native ownership")
      unlinkSync(marker)
      released = true
    },
  }
}

/** Shared native operation admission. A maintenance gate excludes new effects, not ordinary WAL peers. */
export function admitProfileOperation(root: Root) {
  return operation(root)
}

function operation(root: Root, history?: Root) {
  const state = resolved(root)
  const names = files(state)
  if (existsSync(names.gate)) throw new Error("Profile maintenance excludes this profile operation")
  mkdirSync(names.writers, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const marker = path.join(names.writers, token + ".json")
  const record = JSON.stringify({ pid: process.pid, hostname: os.hostname(), token })
  let metadata = history ? lstatSync(names.writers, { bigint: true }) : undefined
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink()))
    throw new Error("Covered profile writer metadata is not a regular directory")
  try {
    publish(marker, record)
  } catch (err) {
    const failure: unknown = err instanceof AggregateError && err.errors.length === 1 ? err.errors[0] : undefined
    if (
      !failure ||
      typeof failure !== "object" ||
      !("code" in failure) ||
      failure.code !== "ENOENT" ||
      !("syscall" in failure) ||
      failure.syscall !== "link" ||
      !("dest" in failure) ||
      failure.dest !== marker ||
      !("path" in failure) ||
      typeof failure.path !== "string" ||
      path.dirname(failure.path) !== boundary(state).dir ||
      !/^\.record-[0-9a-f-]+\.pending$/.test(path.basename(failure.path)) ||
      existsSync(failure.path) ||
      existsSync(names.writers) ||
      boundary(resolved(root)).key !== boundary(state).key
    )
      throw err
    if (existsSync(names.gate)) throw new Error("Profile maintenance excludes this profile operation", { cause: err })
    mkdirSync(names.writers, { recursive: true, mode: 0o700 })
    if (history) {
      metadata = lstatSync(names.writers, { bigint: true })
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Covered profile writer metadata is not a regular directory", { cause: err })
    }
    publish(marker, record)
  }
  if (existsSync(names.gate)) {
    unlinkSync(marker)
    throw new Error("Profile maintenance excludes this profile operation")
  }
  ProfileRoots.register(history ?? state)
  const release = () => {
    if (readFileSync(marker, "utf8") !== record)
      throw new Error("Refusing to release changed profile operation ownership")
    unlinkSync(marker)
  }
  if (!history) return { release }
  try {
    const info = lstatSync(names.writers, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Covered profile writer metadata is not a regular directory")
    if (!metadata || info.dev !== metadata.dev || info.ino !== metadata.ino || readFileSync(marker, "utf8") !== record)
      throw new Error("Covered profile marker directory changed during admission")
    return { release, pin: { path: names.writers, dev: info.dev, ino: info.ino, directory: true } }
  } catch (err) {
    try {
      release()
    } catch (failure) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError preserves both raw causes; its options are the third argument.
      throw new AggregateError([err, failure], "Profile marker binding and release failed", { cause: failure })
    }
    throw err
  }
}

async function natives(root: Root) {
  const names = files(root)
  const active = await readdir(names.owners).catch((err: unknown) => {
    if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
    return []
  })
  for (const name of active) {
    const file = path.join(names.owners, name)
    const raw = await readFile(file, "utf8")
    const owner: unknown = JSON.parse(raw)
    if (
      !owner ||
      typeof owner !== "object" ||
      !("format" in owner) ||
      owner.format !== "raya.profile-native-owner" ||
      !("version" in owner) ||
      owner.version !== 1 ||
      !("root" in owner) ||
      owner.root !== normalize(root.path) ||
      !("hostname" in owner) ||
      owner.hostname !== os.hostname() ||
      !("pid" in owner) ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !("token" in owner) ||
      typeof owner.token !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.token) ||
      `${owner.token}.json` !== name
    )
      throw new Error("Profile native ownership is uncertain")
    const dead = (() => {
      try {
        process.kill(owner.pid, 0)
        return false
      } catch (err) {
        return !!err && typeof err === "object" && "code" in err && err.code === "ESRCH"
      }
    })()
    // A live or reused PID is never reclaimed; no heartbeat/birth estimate grants authority.
    if (!dead) throw new Error("Profile native owners remain live or uncertain")
    if ((await readFile(file, "utf8")) !== raw) throw new Error("Profile native ownership changed during verification")
    await unlink(file)
  }
  if (
    (
      await readdir(names.owners).catch((err: unknown) => {
        if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
        return []
      })
    ).length
  )
    throw new Error("Profile native owners remain registered")
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
  return acquire({ ...root }, options)
}

async function pin(file: string): Promise<Pin> {
  const info = await lstat(file, { bigint: true }).catch((err: unknown) => {
    if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
    return undefined
  })
  if (info) return { path: file, dev: info.dev, ino: info.ino, directory: info.isDirectory() && !info.isSymbolicLink() }
  const parent = path.dirname(file)
  if (parent === file) throw new Error("Profile namespace has no existing ancestor")
  return pin(parent)
}

async function namespace(owner: Owner, retired = false) {
  if ((!owner.active && !retired) || owner.root.kind !== "json" || !owner.pin?.directory)
    throw new Error("Covered profile namespace is unavailable or expired")
  const current = await resolveProfileRoot({ kind: "json", path: owner.selected })
  if (current.id !== boundary(owner.root).key) throw new Error("Covered profile namespace binding changed")
  const anchor = await pin(owner.pin.path)
  if (
    anchor.path !== owner.pin.path ||
    anchor.dev !== owner.pin.dev ||
    anchor.ino !== owner.pin.ino ||
    !anchor.directory
  )
    throw new Error("Covered profile namespace physical identity changed")
  const present = await pin(owner.root.path)
  if (!present.directory) throw new Error("Covered profile namespace is not a directory")
  if (present.path === owner.root.path) owner.pin = present
}

async function reference(owner: Owner, root: Root & { id: string }): Promise<Reference> {
  await namespace(owner)
  const dir = path.join(boundary(root).dir, "covered.references")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const canonical = await resolveProfileRoot({ kind: "json", path: dir })
  if (normalize(canonical.path) !== normalize(dir)) throw new Error("Covered reference container binding changed")
  const info = await lstat(dir, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Covered reference container is not a regular directory")
  await namespace(owner)
  const token = randomUUID()
  const file = path.join(dir, `${Hash.fast(root.id)}.${token}.json`)
  const record = JSON.stringify({
    format: "raya.profile-covered-reference",
    version: 1,
    namespace: normalize(owner.root.path),
    root: normalize(root.path),
    pid: process.pid,
    hostname: os.hostname(),
    token,
  })
  if (Buffer.byteLength(record) > 4096) throw new Error("Covered reference publication exceeds its byte bound")
  publish(file, record)
  const current = lstatSync(file, { bigint: true })
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || readFileSync(file, "utf8") !== record)
    throw new Error("Covered reference publication identity changed")
  return {
    root,
    dir: { path: dir, dev: info.dev, ino: info.ino, directory: true },
    pin: { path: file, dev: current.dev, ino: current.ino, directory: false },
    record,
  }
}

function retain(owner: Owner, id: string, root: Root, ref: Reference, pin?: Pin) {
  const entry = owner.cleanup.get(id) ?? { root, pin, refs: new Set<Reference>() }
  entry.pin ??= pin
  entry.refs.add(ref)
  owner.cleanup.set(id, entry)
}

async function unreference(ref: Reference) {
  const dir = await lstat(ref.dir.path, { bigint: true })
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.dev !== ref.dir.dev || dir.ino !== ref.dir.ino)
    throw new Error("Covered reference container physical identity changed")
  const before = await lstat(ref.pin.path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.dev !== ref.pin.dev ||
    before.ino !== ref.pin.ino ||
    (await readFile(ref.pin.path, "utf8")) !== ref.record
  )
    throw new Error("Covered reference ownership changed")
  const after = await lstat(ref.pin.path, { bigint: true })
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1n ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  )
    throw new Error("Covered reference physical identity changed")
  await unlink(ref.pin.path)
}

async function cleanup(owner: Owner, timeout: number) {
  const stop = performance.now() + timeout
  for (const [id, entry] of owner.cleanup) {
    const root = entry.root
    await namespace(owner, true)
    const current = await resolveProfileRoot(root)
    if (current.id !== id) throw new Error("Covered profile cleanup binding changed")
    const relative = path.relative(normalize(owner.root.path), normalize(current.path))
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new Error("Covered profile cleanup escapes its namespace")
    const lock = boundary(root)
    const metadata = await lstat(lock.dir, { bigint: true })
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Covered profile metadata root is not a regular directory")
    const remaining = Math.ceil(stop - performance.now())
    if (remaining <= 0) throw new Error("Covered profile cleanup deadline elapsed")
    await Flock.withLock(
      lock.key,
      async () => {
        await namespace(owner, true)
        if ((await resolveProfileRoot(root)).id !== id) throw new Error("Covered profile cleanup binding changed")
        const current = await lstat(lock.dir, { bigint: true })
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== metadata.dev ||
          current.ino !== metadata.ino
        )
          throw new Error("Covered profile metadata root physical identity changed")
        const file = files(root).writers
        const before = await lstat(file, { bigint: true }).catch((err: unknown) => {
          if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
          return undefined
        })
        if (before && (!before.isDirectory() || before.isSymbolicLink()))
          throw new Error("Covered profile writer metadata is not a regular directory")
        if (
          before &&
          entry.pin &&
          (file !== entry.pin.path || before.dev !== entry.pin.dev || before.ino !== entry.pin.ino)
        )
          throw new Error("Covered profile writer metadata admission identity changed")
        for (const ref of entry.refs) {
          await unreference(ref)
          entry.refs.delete(ref)
          owner.count--
        }
        const container = path.join(lock.dir, "covered.references")
        const held = await lstat(container, { bigint: true })
        if (!held.isDirectory() || held.isSymbolicLink())
          throw new Error("Covered reference container is not a regular directory")
        const refs = await readdir(container)
        if (refs.length > 4096) throw new Error("Covered reference enumeration exceeds its bound")
        const prefix = Hash.fast(id) + "."
        if (
          refs.some(
            (name) =>
              !/^[0-9a-f]{40}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(name) ||
              name.startsWith(prefix),
          )
        )
          return
        for (const name of refs) {
          const info = await lstat(path.join(container, name), { bigint: true }).catch((err: unknown) => {
            if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
            return undefined
          })
          // Other references can retain metadata, never authorize deletion or recover a lease.
          if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 4096n) return
          const raw = await readFile(path.join(container, name), "utf8").catch((err: unknown) => {
            if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
            return undefined
          })
          if (raw === undefined || Buffer.byteLength(raw) > 4096) return
          const value: unknown = (() => {
            try {
              return JSON.parse(raw)
            } catch {
              return undefined
            }
          })()
          if (
            !value ||
            typeof value !== "object" ||
            !("format" in value) ||
            value.format !== "raya.profile-covered-reference" ||
            !("version" in value) ||
            value.version !== 1 ||
            !("root" in value) ||
            typeof value.root !== "string" ||
            !path.isAbsolute(value.root) ||
            !("namespace" in value) ||
            typeof value.namespace !== "string" ||
            !path.isAbsolute(value.namespace) ||
            !("pid" in value) ||
            typeof value.pid !== "number" ||
            !Number.isSafeInteger(value.pid) ||
            value.pid <= 0 ||
            !("hostname" in value) ||
            typeof value.hostname !== "string" ||
            !("token" in value) ||
            typeof value.token !== "string" ||
            Object.keys(value).length !== 7 ||
            `${Hash.fast(boundary({ kind: "json", path: value.root }).key)}.${value.token}.json` !== name
          )
            return
          const relative = path.relative(value.namespace, value.root)
          if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
            return
        }
        if (!before || !entry.pin) return
        const native = await lstat(files(root).owners).catch((err: unknown) => {
          if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
          return undefined
        })
        if (native && (!native.isDirectory() || native.isSymbolicLink()))
          throw new Error("Covered profile native metadata is not a regular directory")
        if (native && (await readdir(files(root).owners)).length) return
        await drain(root, stop)
        if ((await readdir(file)).length) return
        const after = await lstat(file, { bigint: true })
        if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino)
          throw new Error("Covered profile writer metadata physical identity changed")
        if (native && (await readdir(files(root).owners)).length) return
        await rmdir(file).catch((err: unknown) => {
          if (
            !err ||
            typeof err !== "object" ||
            !("code" in err) ||
            (err.code !== "ENOENT" && err.code !== "ENOTEMPTY")
          )
            throw err
        })
      },
      { dir: lock.dir, timeoutMs: remaining, recover: "dead" },
    )
    owner.cleanup.delete(id)
  }
}

async function acquire(root: Root, options: Options, history?: Root) {
  const timeout = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
    throw new Error("Profile maintenance admission deadline is invalid")
  const resolved = await resolveProfileRoot(root)
  const stop = performance.now() + timeout
  while (true) {
    options.signal?.throwIfAborted()
    const lease = (() => {
      try {
        return history ? operation(resolved, history) : admitProfileOperation(resolved)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("maintenance excludes")) throw error
        return undefined
      }
    })()
    if (lease) {
      const owner: Owner = {
        root: { kind: resolved.kind, path: resolved.path },
        selected: root.path,
        history: history ?? { kind: resolved.kind, path: resolved.path },
        marker: "pin" in lease ? lease.pin : undefined,
        children: new Set(),
        cleanup: new Map(),
        count: 0,
        active: true,
        closing: false,
      }
      try {
        if (root.kind === "json") owner.pin = await pin(resolved.path)
      } catch (err) {
        try {
          lease.release()
        } catch (failure) {
          // oxlint-disable-next-line preserve-caught-error -- AggregateError preserves both raw causes; its options are the third argument.
          throw new AggregateError([err, failure], "Profile admission binding and release failed", { cause: failure })
        }
        throw err
      }
      const finish = () => {
        owner.closing = true
        if (owner.children.size) throw new Error("Covered profile operations remain active")
        if (owner.cleanup.size) throw new Error("Covered profile metadata cleanup requires asynchronous release")
        lease.release()
        owner.active = false
      }
      const release = async () => {
        owner.closing = true
        if (!owner.active && !owner.cleanup.size) lease.release()
        await Promise.all([...owner.children].map((child) => child.done))
        if (owner.children.size)
          throw new AggregateError(
            [...owner.children].map((child) => child.error ?? new Error("Covered profile operation remains active")),
            "Covered profile operations failed to release",
          )
        if (owner.active) {
          lease.release()
          owner.active = false
        }
        await cleanup(owner, timeout)
      }
      const result = {
        id: resolved.id,
        root: Object.freeze({ kind: resolved.kind, path: resolved.path }),
        release,
        finish,
        [Symbol.asyncDispose]: release,
      }
      owners.set(result, owner)
      return result
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

/** Exact operation markers remain independently gated; history is the authentic enclosing namespace. */
export async function acquireCoveredProfileRoot(root: Root, lease: unknown, options: Options = {}) {
  const owner = typeof lease === "object" && lease !== null ? owners.get(lease) : undefined
  if (!owner?.active || owner.closing || owner.root.kind !== "json" || root.kind !== "json")
    throw new Error("Covered profile namespace is unavailable or expired")
  if (owner.count >= 4096) throw new Error("Covered profile operation intake exceeds its bound")
  const input = { ...root }
  let resolve!: () => void
  const joined = new Promise<void>((done) => {
    resolve = done
  })
  const child: Child = { done: joined, finish: resolve }
  owner.children.add(child)
  owner.count++
  const check = async (id?: string) => {
    await namespace(owner)
    const current = await resolveProfileRoot(input)
    const relative = path.relative(normalize(owner.root.path), normalize(current.path))
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new Error("Covered profile operation escapes its namespace")
    if (id && current.id !== id) throw new Error("Covered profile operation binding changed")
    return current
  }
  let held: Awaited<ReturnType<typeof acquire>> | undefined
  let ref: Reference | undefined
  try {
    const target = await check()
    ref = await reference(owner, target)
    held = await acquire(input, options, owner.history)
    await check(held.id)
    if (held.id !== target.id) throw new Error("Covered profile operation binding changed")
    const current = held
    const retained = ref
    const metadata = owners.get(current)?.marker
    if (!metadata) throw new Error("Covered profile marker directory authority is unavailable")
    const finish = () => {
      const canonical = resolved(input)
      const anchor = owner.pin && lstatSync(owner.pin.path, { bigint: true })
      if (
        !owner.active ||
        boundary(resolved({ kind: "json", path: owner.selected })).key !== boundary(owner.root).key ||
        !anchor?.isDirectory() ||
        anchor.dev !== owner.pin?.dev ||
        anchor.ino !== owner.pin?.ino ||
        boundary(canonical).key !== current.id
      )
        throw new Error("Covered profile operation binding changed")
      current.finish()
      retain(owner, current.id, current.root, retained, metadata)
      owner.children.delete(child)
      child.finish()
    }
    const release = async () => {
      const errors: unknown[] = []
      await check(current.id).catch((err: unknown) => errors.push(err))
      await current.release().catch((err: unknown) => {
        child.error = err
        errors.push(err)
      })
      if (!owners.get(current)?.active) {
        retain(owner, current.id, current.root, retained, metadata)
        owner.children.delete(child)
      }
      child.finish()
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, "Covered profile operation release failed")
    }
    const result = { id: current.id, root: current.root, release, finish, [Symbol.asyncDispose]: release }
    const state = owners.get(current)
    if (!state) throw new Error("Covered profile operation authority is unavailable")
    owners.set(result, state)
    return result
  } catch (err) {
    const errors = [err]
    if (held)
      await held.release().catch((failure: unknown) => {
        child.error = failure
        errors.push(failure)
      })
    if (!held || !owners.get(held)?.active) {
      const metadata = held && owners.get(held)?.marker
      if (ref) retain(owner, boundary(ref.root).key, ref.root, ref, metadata)
      if (!ref) owner.count--
      owner.children.delete(child)
    }
    child.finish()
    if (errors.length === 1) throw err
    // oxlint-disable-next-line preserve-caught-error -- AggregateError preserves both raw causes; its options are the third argument.
    throw new AggregateError(errors, "Covered profile admission and release failed", { cause: err })
  }
}

async function hold<T>(roots: readonly Root[], body: () => Promise<T>, options: Options, join = true) {
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
        if (join) await drain(roots[index], started + timeout, options.signal)
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

/** Retire owners before entering: closing a native handle itself needs operation admission. */
export function coordinateProfileNatives<T>(scope: Scope, body: () => Promise<T>, options: Options = {}) {
  if (scope.roots.length !== 2 || new Set(scope.roots.map((root) => root.kind)).size !== 2)
    throw new Error("Profile maintenance roots are incomplete")
  return hold(
    scope.roots,
    async () => {
      for (const root of scope.roots) await natives(root)
      return {
        value: await body(),
        admission: {
          format: "raya.profile-native-maintenance",
          version: 1,
          scope: scope.id,
          nativeOwners: 0,
          operations: 0,
          cooperativeOnly: true,
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
        },
      }
    },
    options,
  )
}

/** Explicit participating roots only: this never discovers a complete profile or initializes native owners. */
export async function coordinateNativeRoots<T>(
  roots: readonly Root[],
  body: (admission: ProfileAdmission) => Promise<T>,
  options: Options = {},
) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error("Profile maintenance roots are empty")
  const selected = roots.map((root) => {
    if (!root || (root.kind !== "sqlite" && root.kind !== "json") || typeof root.path !== "string")
      throw new Error("Unknown profile maintenance root")
    return { kind: root.kind, path: root.path }
  })
  const resolved = await Promise.all(selected.map(resolveProfileRoot))
  const distinct = [...new Map(resolved.map((root) => [root.id, root])).values()]
  distinct.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const canonical = Object.freeze(distinct.map((root) => Object.freeze({ kind: root.kind, path: root.path })))
  const scope = createHash("sha256")
    .update(JSON.stringify(canonical.map((root) => ({ ...root, path: normalize(root.path) }))))
    .digest("hex")
  const timeout = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
    throw new Error("Profile maintenance admission deadline is invalid")
  const stop = performance.now() + timeout
  const retry = Symbol("Active profile operations require gate release")
  const empty = async () => {
    for (const root of canonical) {
      const active = await readdir(files(root).writers).catch((err: unknown) => {
        if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") throw err
        return []
      })
      if (active.length) return false
    }
    return true
  }
  while (true) {
    options.signal?.throwIfAborted()
    const remaining = Math.floor(stop - performance.now())
    if (remaining <= 0) throw new Error("Profile maintenance admission deadline elapsed")
    const result = await hold(
      canonical,
      async () => {
        // Accepted parents must be able to finish their gated children before capture can proceed.
        if (!(await empty())) return retry
        for (const root of canonical) await natives(root)
        if (!(await empty())) return retry
        options.signal?.throwIfAborted()
        if (performance.now() >= stop) throw new Error("Profile maintenance admission deadline elapsed")
        const admission = Object.freeze({
          format: "raya.profile-root-maintenance",
          version: 1,
          scope,
          roots: canonical,
          nativeOwners: 0,
          operations: 0,
          participantOnly: true,
          cooperativeOnly: true,
          completeProfileCoverage: false,
          portableCaptureAuthorized: false,
          portable: false,
        } as const)
        return { value: await body(admission), admission }
      },
      { ...options, timeoutMs: remaining },
      false,
    )
    if (result !== retry) return result
    // hold has joined every gate release. New intake may race here; the next full barrier rechecks it.
    for (const root of canonical) await drain(root, stop, options.signal)
  }
}

export type ProfileAdmission = Readonly<{
  format: "raya.profile-root-maintenance"
  version: 1
  scope: string
  roots: readonly Readonly<Root>[]
  nativeOwners: 0
  operations: 0
  participantOnly: true
  cooperativeOnly: true
  completeProfileCoverage: false
  portableCaptureAuthorized: false
  portable: false
}>
