import { randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { closeProfileSqlite } from "./profile-sqlite"

type Phase = "open" | "draining" | "closed" | "refused"
type Owner = { id: string; root: Root; native?: object; closing?: Promise<void> }
type Root = { path: string; phase: Phase; owners: Map<string, Owner>; drain?: Promise<Receipt> }
type Receipt = {
  format: "raya.database-lifecycle"
  version: 1
  root: string
  status: "confirmed"
  instances: number
  processLocal: true
  portableCaptureAuthorized: false
}

const roots = new Map<string, Root>()
const owners = new WeakMap<object, Owner>()

function root(filename: string): Root {
  const canonical = (file: string): string => {
    if (existsSync(file)) return realpathSync(file)
    const parent = path.dirname(file)
    if (parent === file) return realpathSync(file)
    return path.join(canonical(parent), path.basename(file))
  }
  const file = filename === ":memory:" ? filename : canonical(path.resolve(filename))
  const key = process.platform === "win32" ? file.toLowerCase() : file
  const current = roots.get(key)
  if (current) return current
  const value: Root = { path: file, phase: "open", owners: new Map() }
  roots.set(key, value)
  return value
}

function check(state: Root) {
  if (state.phase !== "open") throw new Error(`Database service acquisition is ${state.phase}`)
}

/** Fence preflight before it can repair or create files; no profile bootstrap occurs here. */
export function prepareDatabase<A>(filename: string, body: () => A): A {
  check(root(filename))
  return body()
}

/** Register each native Core service instance before construction, independently of Layer memoization. */
export function openDatabase<A extends object>(filename: string, body: () => A): A {
  const state = root(filename)
  check(state)
  const owner: Owner = { id: randomUUID(), root: state }
  state.owners.set(owner.id, owner)
  try {
    const native = body()
    owner.native = native
    owners.set(native, owner)
    return native
  } catch (err) {
    state.owners.delete(owner.id)
    throw err
  }
}

/** Scope finalizers retain registration until the exact native close has succeeded. */
export function closeDatabase(native: object): Promise<void> {
  const owner = owners.get(native)
  if (!owner) return Promise.reject(new Error("Database service has no lifecycle owner"))
  owner.closing ??= closeProfileSqlite(native).then(() => {
    owner.root.owners.delete(owner.id)
  })
  return owner.closing
}

/** The caller must dispose all owning service scopes; this never closes an active transaction for them. */
export function drainDatabase(filename: string, dispose: () => Promise<void>, timeout = 5_000): Promise<Receipt> {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
    return Promise.reject(new Error("Database lifecycle deadline is invalid"))
  const state = root(filename)
  if (state.path === ":memory:") return Promise.reject(new Error("An in-memory database has no transferable root"))
  if (state.drain) return state.drain
  check(state)
  state.phase = "draining"
  const count = state.owners.size
  const pending = Promise.resolve().then(dispose)
  const timer: { value?: ReturnType<typeof setTimeout> } = {}
  const deadline = new Promise<never>((_, reject) => {
    timer.value = setTimeout(
      () => reject(new Error("Database service disposal was not confirmed before deadline")),
      timeout,
    )
  })
  state.drain = Promise.race([pending, deadline])
    .then((): Receipt => {
      if (state.owners.size) throw new Error("Database service disposal left registered instances")
      state.phase = "closed"
      return {
        format: "raya.database-lifecycle",
        version: 1,
        root: state.path,
        status: "confirmed",
        instances: count,
        processLocal: true,
        portableCaptureAuthorized: false,
      }
    })
    .catch((err) => {
      state.phase = "refused"
      throw err
    })
    .finally(() => clearTimeout(timer.value))
  return state.drain
}

/** Only a confirmed, fully closed generation can accept new database service instances. */
export function resumeDatabase(filename: string): void {
  const state = root(filename)
  if (state.phase !== "closed" || state.owners.size) throw new Error("Database lifecycle is not confirmed closed")
  state.drain = undefined
  state.phase = "open"
}

export function databaseSnapshot(filename: string) {
  const state = root(filename)
  return { root: state.path, phase: state.phase, instances: [...state.owners.keys()], processLocal: true as const }
}
