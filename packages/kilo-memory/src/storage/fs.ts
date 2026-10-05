import { publish, reclaim } from "./publication"
import { MemoryOperation } from "./operation"
import { AsyncLocalStorage } from "async_hooks"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat as follow,
  utimes,
  writeFile,
} from "fs/promises"
import path from "path"

export namespace MemoryFs {
  const locks = new Map<string, Promise<void>>()
  export const hosted = MemoryOperation.hosted
  export const DIR = 0o700
  export const FILE = 0o600
  const STALE = 30_000
  const local = new AsyncLocalStorage<Set<string>>()
  const proofs = new AsyncLocalStorage<Map<string, () => Promise<void>>>()

  export function warn(message: string, data?: unknown) {
    if (process.env.KILO_MEMORY_DEBUG !== "1") return
    console.warn(`[memory.files] ${message}`, data)
  }

  export function miss(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  }

  export async function exists(file: string) {
    await parents(path.dirname(file))
    return Boolean(await guard(file))
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function code(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
  }

  export function parse(error: unknown) {
    return error instanceof SyntaxError
  }

  export function brief(error: unknown) {
    return error instanceof Error ? error.message.replaceAll(/\s+/g, " ").slice(0, 160) : String(error).slice(0, 160)
  }

  function trusted(file: string) {
    if (process.platform !== "darwin") return false
    return file === "/var" || file === "/tmp" || file === "/etc"
  }

  export async function guard(file: string) {
    const info = await lstat(file).catch((error: unknown) => {
      if (miss(error)) return
      throw error
    })
    if (info?.isSymbolicLink()) {
      if (trusted(path.resolve(file))) return follow(file)
      throw new Error(`memory path rejects symlink: ${file}`)
    }
    return info
  }

  async function parents(file: string) {
    const root = path.parse(path.resolve(file)).root
    const parts = path.resolve(file).slice(root.length).split(path.sep).filter(Boolean)
    await parts.reduce(async (prev, part) => {
      const base = await prev
      const next = path.join(base, part)
      const info = await guard(next)
      if (info && !info.isDirectory()) throw new Error(`memory parent is not a directory: ${next}`)
      return next
    }, Promise.resolve(root))
  }

  export async function dir(file: string) {
    const files = [file, path.dirname(file)]
    for (const parent of files) {
      if (await guard(parent)) break
      const next = path.dirname(parent)
      if (next !== parent && !files.includes(next)) files.push(next)
    }
    return MemoryOperation.mutate(files, async () => {
      await parents(path.dirname(file))
      await guard(file)
      await mkdir(file, { recursive: true, mode: DIR })
      await chmod(file, DIR).catch((error: unknown) => {
        if (process.platform === "win32") return
        throw error
      })
      const info = await guard(file)
      if (!info?.isDirectory()) throw new Error(`memory path is not a directory: ${file}`)
    })
  }

  export function write(file: string, text: string) {
    if (!MemoryOperation.hosted()) return standalone(file, text)
    return publish(file, text, async () => {
      await dir(path.dirname(file))
      const info = await guard(file)
      if (info && !info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    })
  }

  async function standalone(file: string, text: string) {
    const salt = Math.random().toString(36).slice(2)
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${salt}.tmp`)
    return MemoryOperation.mutate([file, path.dirname(file), tmp], async () => {
      await dir(path.dirname(file))
      const info = await guard(file)
      if (info && !info.isFile()) throw new Error(`memory path is not a file: ${file}`)
      await writeFile(tmp, text, { mode: FILE })
      await chmod(tmp, FILE).catch((error: unknown) => {
        if (process.platform === "win32") return
        throw error
      })
      await rename(tmp, file).catch(async (error: unknown) => {
        await rm(tmp, { force: true }).catch((err: unknown) => {
          throw new AggregateError([error, err], "Memory publication and cleanup failed")
        })
        throw error
      })
      await chmod(file, FILE).catch((error: unknown) => {
        if (process.platform === "win32") return
        throw error
      })
    })
  }

  export async function read(file: string) {
    await parents(path.dirname(file))
    const info = await guard(file)
    if (!info) return undefined
    if (!info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    return readFile(file, "utf8")
  }

  export async function remove(file: string) {
    return MemoryOperation.mutate([file, path.dirname(file)], async () => {
      await parents(path.dirname(file))
      const info = await guard(file)
      if (!info) return false
      if (!info.isFile()) throw new Error(`memory path is not a file: ${file}`)
      await rm(file, { force: true })
      return true
    })
  }

  export async function json(file: string) {
    const text = await read(file)
    return text === undefined ? undefined : JSON.parse(text)
  }

  export async function backup(file: string) {
    return MemoryOperation.mutate([file, path.dirname(file)], async () => {
      const text = await read(file).catch((error: unknown) => {
        if (miss(error)) return undefined
        throw error
      })
      if (text === undefined) return
      await write(`${file}.bad-${Date.now()}`, text)
      await rm(file, { force: true })
    })
  }

  export async function ensure(file: string, text: string) {
    return MemoryOperation.mutate([file, path.dirname(file)], async () => {
      if (await exists(file)) {
        const info = await guard(file)
        if (!info?.isFile()) throw new Error(`memory path is not a file: ${file}`)
        return
      }
      await write(file, text)
    })
  }

  export async function mtime(file: string) {
    await parents(path.dirname(file))
    const info = await guard(file)
    if (!info) return 0
    if (!info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    return info.mtimeMs
  }

  export async function mtimeNs(file: string) {
    await parents(path.dirname(file))
    const info = await lstat(file, { bigint: true }).catch((error: unknown) => {
      if (miss(error)) return undefined
      throw error
    })
    if (!info) return 0n
    if (info.isSymbolicLink()) throw new Error(`memory path must not be a symlink: ${file}`)
    return info.mtimeNs
  }

  async function tree(file: string) {
    const rows: { file: string; dev: string; ino: string; directory: boolean }[] = []
    async function visit(file: string) {
      await parents(path.dirname(file))
      const identity = await lstat(file, { bigint: true }).catch((err) => {
        if (miss(err)) return undefined
        throw err
      })
      if (!identity) return
      if (rows.length >= 10000) throw new Error("Memory recursive mutation exceeds 10000 entries")
      if (identity.isSymbolicLink()) throw new Error("Memory recursive mutation rejects links")
      if (!identity.isDirectory() && !identity.isFile())
        throw new Error("Memory recursive mutation rejects special files")
      rows.push({ file, dev: String(identity.dev), ino: String(identity.ino), directory: identity.isDirectory() })
      if (identity.isDirectory())
        for (const name of (await readdir(file)).sort()) {
          if (MemoryOperation.hosted() && name === ".raya-profile-locks") continue
          if (MemoryOperation.hosted() && name === ".lock" && nested(file)) {
            const proof = proofs.getStore()?.get(file)
            if (!proof) throw new Error("Memory queue lock proof is unavailable")
            await proof()
            continue
          }
          await visit(path.join(file, name))
        }
    }
    await visit(file)
    return rows
  }

  async function check(file: string, rows: Awaited<ReturnType<typeof tree>>) {
    const current = await tree(file)
    if (JSON.stringify(current) !== JSON.stringify(rows)) throw new Error("Memory recursive mutation binding changed")
  }

  export async function erase(file: string) {
    if (!MemoryOperation.hosted()) return rm(file, { recursive: true, force: true })
    const rows = await tree(file)
    return MemoryOperation.mutate(
      [file, path.dirname(file), ...rows.flatMap((row) => [row.file, path.dirname(row.file)])],
      async () => {
        await check(file, rows)
        if (!MemoryOperation.hosted()) return rm(file, { recursive: true, force: true })
        const retained = new Set<string>(nested(file) ? [path.join(file, ".lock")] : [])
        for (const row of [...rows].reverse()) {
          if (!row.directory) {
            await remove(row.file)
            continue
          }
          const names = await readdir(row.file)
          if (
            names.length &&
            names.every((name) => name === ".raya-profile-locks" || retained.has(path.join(row.file, name)))
          ) {
            retained.add(row.file)
            continue
          }
          if (names.length) throw new Error("Memory recursive mutation found new content")
          await rmdir(row.file)
        }
        await proofs.getStore()?.get(file)?.()
      },
    )
  }

  export async function empty(file: string) {
    return (await tree(file)).every((row) => row.directory)
  }

  async function move(file: string, target: string) {
    if (!MemoryOperation.hosted()) return rename(file, target)
    const rows = await tree(file)
    return MemoryOperation.mutate(
      [
        file,
        target,
        path.dirname(file),
        ...rows.flatMap((row) => [row.file, path.join(target, path.relative(file, row.file))]),
      ],
      async () => {
        await check(file, rows)
        await rename(file, target)
      },
    )
  }

  async function lock(root: string) {
    await dir(root)
    const file = path.join(root, ".lock")
    const acquire = async (left: number): Promise<(() => Promise<void>) & { check: () => Promise<void> }> => {
      try {
        if (MemoryOperation.hosted()) await dir(file)
        else await mkdir(file, { mode: DIR })
        const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
        const owner = path.join(file, "owner")
        const handle = MemoryOperation.hosted() ? await open(owner, "wx", FILE) : undefined
        await (handle ? handle.writeFile(token) : writeFile(owner, token, { mode: FILE })).catch(
          async (error: unknown) => {
            if (handle) {
              await handle.close().catch((err) => {
                throw new AggregateError([error, err], "Memory lock acquisition and close failed")
              })
              throw error
            }
            await erase(file).catch((err) => {
              throw new AggregateError([error, err], "Memory lock acquisition and cleanup failed")
            })
            throw error
          },
        )
        const identities = await Promise.all([
          lstat(file, { bigint: true }),
          handle ? handle.stat({ bigint: true }) : lstat(owner, { bigint: true }),
        ]).catch(async (error) => {
          await handle?.close().catch((err) => {
            throw new AggregateError([error, err], "Memory lock inspection and close failed")
          })
          throw error
        })
        const check = async () => {
          const current = await Promise.all([lstat(file, { bigint: true }), lstat(owner, { bigint: true })])
          if (
            current.some(
              (info, index) =>
                info.isSymbolicLink() || info.dev !== identities[index].dev || info.ino !== identities[index].ino,
            ) ||
            (await readFile(owner, "utf8")) !== token
          )
            throw new Error("Memory queue lock physical identity changed")
        }
        await check().catch(async (error) => {
          await handle?.close().catch((err) => {
            throw new AggregateError([error, err], "Memory lock binding and close failed")
          })
          throw error
        })
        const pending = new Set<Promise<void>>()
        const failures: unknown[] = []
        const timer = setInterval(
          () => {
            const now = new Date()
            const work = handle
              ? check().then(async () => {
                  await handle.utimes(now, now)
                  await check()
                })
              : utimes(file, now, now)
            const settled = work.then(
              () => {
                pending.delete(settled)
              },
              (err) => {
                failures.push(err)
                pending.delete(settled)
              },
            )
            pending.add(settled)
          },
          Math.floor(STALE / 3),
        )
        timer.unref()
        return Object.assign(
          async () => {
            clearInterval(timer)
            await Promise.all(pending)
            const active = await readFile(owner, "utf8").catch((err: unknown) => {
              failures.push(err)
              return undefined
            })
            if (active !== token) failures.push(new Error("Memory lock ownership changed before release"))
            if (active === token) {
              await check()
                .then(async () => {
                  await (MemoryOperation.hosted() ? remove(owner) : erase(file))
                })
                .catch((err) => {
                  failures.push(err)
                })
            }
            await handle?.close().catch((err) => {
              failures.push(err)
            })
            if (failures.length === 1) throw failures[0]
            if (failures.length) throw new AggregateError(failures, "Memory lock heartbeat or release failed")
          },
          { check },
        )
      } catch (error) {
        if (code(error) !== "EEXIST") throw error
        const info = await guard(file)
        if (!info?.isDirectory()) throw new Error(`memory lock is not a directory: ${file}`, { cause: error })
        const stamp = MemoryOperation.hosted() ? await guard(path.join(file, "owner")) : info
        if (!stamp || (!stamp.isFile() && MemoryOperation.hosted()))
          throw new Error("Memory lock owner is unknown", { cause: error })
        if (Date.now() - stamp.mtimeMs > STALE) {
          const selected = MemoryOperation.hosted() ? path.join(file, "owner") : file
          if (MemoryOperation.hosted()) {
            const token = await readFile(selected, "utf8")
            const match = token.match(/^(\d+)\.(\d+)\.([a-z0-9]+)$/)
            if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0)
              throw new Error("Memory stale lock owner is unknown", { cause: error })
            try {
              process.kill(Number(match[1]), 0)
              throw new Error("Memory stale lock owner is still live", { cause: error })
            } catch (err) {
              if (code(err) !== "ESRCH") throw err
            }
            await reclaim(selected, token)
            return acquire(left)
          }
          const stolen = `${selected}.steal.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
          const moved = await move(selected, stolen).then(
            () => true,
            async (err: unknown) => {
              if (code(err) === "ENOENT") return false
              if (code(err) === "EEXIST") {
                await sleep(50)
                return false
              }
              throw err
            },
          )
          if (moved) await erase(stolen)
          return acquire(left)
        }
        if (left <= 0) throw new Error(`timed out waiting for memory lock: ${root}`, { cause: error })
        await sleep(50)
        return acquire(left - 1)
      }
    }
    return acquire(800)
  }

  function nested(root: string) {
    return local.getStore()?.has(root) === true
  }

  export function queue<T>(root: string, fn: () => Promise<T>): Promise<T> {
    return MemoryOperation.run(root, () =>
      MemoryOperation.mutate([root, path.join(root, ".lock"), path.join(root, ".lock", "owner")], () =>
        queued(root, fn),
      ),
    )
  }

  async function queued<T>(root: string, fn: () => Promise<T>): Promise<T> {
    if (nested(root)) return fn()
    const prev = locks.get(root) ?? Promise.resolve()
    const next = prev
      .catch((err: unknown) => {
        warn("previous memory queue operation failed", { root, err })
      })
      .then(async () => {
        const release = await lock(root)
        const roots = new Set(local.getStore() ?? [])
        roots.add(root)
        const checks = new Map(proofs.getStore() ?? [])
        checks.set(root, release.check)
        const result = await proofs
          .run(checks, () => local.run(roots, fn))
          .then(
            (value) => ({ value: { value }, errors: [] as unknown[] }),
            (err) => ({ value: undefined, errors: [err] as unknown[] }),
          )
        await release().catch((err) => {
          result.errors.push(err)
        })
        if (result.errors.length === 1) throw result.errors[0]
        if (result.errors.length) throw new AggregateError(result.errors, "Memory queue operation or release failed")
        if (!result.value) throw new Error("Memory queue has no completed result")
        return result.value.value
      })
    const done = next.then(
      () => undefined,
      () => undefined,
    )
    locks.set(root, done)
    try {
      return await next
    } finally {
      if (locks.get(root) === done) locks.delete(root)
    }
  }
}
