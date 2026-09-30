import path from "node:path"
import { acquireProfileRoot, admitProfileOperation } from "./profile-maintenance"

const closers = new WeakMap<object, () => Promise<void>>()
function cursor(value: unknown): value is Iterator<unknown, unknown, unknown> {
  if (!value || typeof value !== "object" || !("next" in value) || typeof value.next !== "function") return false
  for (const key of ["return", "throw"])
    if (key in value && Reflect.get(value, key) !== undefined && typeof Reflect.get(value, key) !== "function")
      return false
  return true
}

export function closeProfileSqlite(native: object) {
  const close = closers.get(native)
  if (!close) throw new Error("SQLite client has no profile admission owner")
  return close()
}

/** Fence actual native execution, including raw Drizzle clients and SQL transaction statements. */
export function profileSqlite<T extends object>(filename: string, open: () => T): T {
  if (filename === ":memory:") {
    const native = open()
    closers.set(native, async () => {
      const close: unknown = Reflect.get(native, "close")
      if (typeof close !== "function") throw new Error("SQLite client has no close method")
      Reflect.apply(close, native, [])
    })
    return native
  }
  const root = { kind: "sqlite" as const, path: path.resolve(filename) }
  const opening = admitProfileOperation(root)
  const native = (() => {
    try {
      return open()
    } finally {
      opening.release()
    }
  })()
  let lease: ReturnType<typeof admitProfileOperation> | undefined
  let depth = 0
  let closed = false
  const active = () =>
    !closed && (Reflect.get(native, "inTransaction") === true || Reflect.get(native, "isTransaction") === true)
  const enter = () => {
    lease ??= admitProfileOperation(root)
    depth += 1
  }
  const exit = () => {
    depth -= 1
    if (depth !== 0 || active()) return
    lease?.release()
    lease = undefined
  }
  const run = (body: () => unknown) => {
    enter()
    try {
      return body()
    } finally {
      exit()
    }
  }
  const statement = (target: object) => {
    const proxy: object = new Proxy(target, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target)
        if (typeof value !== "function") return value
        if (key === "iterate")
          return (...args: unknown[]) => {
            enter()
            const iterator = (() => {
              try {
                const result: unknown = Reflect.apply(value, target, args)
                if (!cursor(result)) throw new Error("SQLite statement returned an invalid iterator")
                return result
              } catch (error) {
                exit()
                throw error
              }
            })()
            let done = false
            const finish = () => {
              if (done) return
              done = true
              exit()
            }
            return {
              [Symbol.iterator]() {
                return this
              },
              next(...args: [] | [unknown]) {
                if (done) return { done: true as const, value: undefined }
                try {
                  const result = iterator.next(...args)
                  if (result.done) finish()
                  return result
                } catch (error) {
                  finish()
                  throw error
                }
              },
              return(value?: unknown) {
                try {
                  return iterator.return?.(value) ?? { done: true as const, value }
                } finally {
                  finish()
                }
              },
              throw(error?: unknown) {
                try {
                  if (iterator.throw) return iterator.throw(error)
                  throw error
                } finally {
                  try {
                    iterator.return?.()
                  } finally {
                    finish()
                  }
                }
              },
            }
          }
        return (...args: unknown[]) => {
          const result = run(() => Reflect.apply(value, target, args))
          return result === target ? proxy : result
        }
      },
    })
    return proxy
  }
  const proxy = new Proxy(native, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== "function") return value
      if (key === "query" || key === "prepare")
        return (...args: unknown[]) => {
          const result = run(() => Reflect.apply(value, target, args))
          if (!result || typeof result !== "object") throw new Error("SQLite client returned an invalid statement")
          return statement(result)
        }
      if (key === "transaction")
        return (...args: unknown[]) => {
          const fn = run(() => Reflect.apply(value, target, args))
          if (typeof fn !== "function") throw new Error("SQLite client returned an invalid transaction")
          const wrap = (body: unknown) => {
            if (typeof body !== "function") throw new Error("SQLite transaction mode is invalid")
            return (...args: unknown[]) => run(() => Reflect.apply(body, undefined, args))
          }
          const result = wrap(fn)
          for (const mode of ["deferred", "immediate", "exclusive"])
            if (typeof Reflect.get(fn, mode) === "function") Reflect.set(result, mode, wrap(Reflect.get(fn, mode)))
          return result
        }
      if (key === "close" || key === Symbol.dispose)
        return (...args: unknown[]) =>
          run(() => {
            const result = Reflect.apply(value, target, args)
            closed = true
            return result
          })
      return (...args: unknown[]) => run(() => Reflect.apply(value, target, args))
    },
  })
  closers.set(proxy, async () => {
    if (!lease) {
      const held = await acquireProfileRoot(root)
      lease = { release: held.finish }
    }
    const close: unknown = Reflect.get(proxy, "close")
    if (typeof close !== "function") throw new Error("SQLite client has no close method")
    Reflect.apply(close, proxy, [])
  })
  return proxy
}
