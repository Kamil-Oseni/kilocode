import path from "node:path"
import { statSync } from "node:fs"
import { registerProfileFile } from "./profile-maintenance"
import { GlobalScopes, SourceScopes } from "./source-scopes"
import { ConfigIntent, ConfigIntentRefusal } from "./config-intent"

const owners = new Map<string, ReturnType<typeof registerProfileFile>>()
const states = new Set<string>()
const globals = new Map<string, ReturnType<typeof GlobalScopes.parse>>()
const failures: unknown[] = []
let closing: Promise<void> | undefined
function freeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}

/** An existing file ancestor makes preferred state writes impossible; its own boundary remains ownable. */
export function registerStateProfile(preferred: string, fallback?: string) {
  const inspect = (file: string): string => {
    try {
      return statSync(file).isDirectory() ? preferred : file
    } catch (err) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
      const parent = path.dirname(file)
      if (parent === file) throw err
      return inspect(parent)
    }
  }
  const accessible = inspect(path.dirname(preferred))
  registerProcessProfile([
    accessible,
    ...(accessible === preferred ? [path.dirname(preferred)] : []),
    ...(fallback ? [fallback] : []),
  ])
}

/** Every managed graph keeps declared profile directories visible until its final native exit boundary. */
export function registerProcessProfile(paths: readonly string[]) {
  if (closing) throw new Error("Process profile ownership is terminal")
  for (const file of paths) {
    if (!path.isAbsolute(file)) throw new Error("Process profile roots must be absolute")
    // registerProfileFile resolves symlinks before taking its lifetime marker.
    const key = process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)
    if (owners.has(key)) continue
    try {
      owners.set(key, registerProfileFile({ kind: "json", path: file }))
    } catch (err) {
      failures.push(err)
      throw err
    }
  }
}

/** Only credential compatibility paths inside the owned home are declared, never its parent directory. */
export function registerGlobalProfile(input: {
  home: string
  data: string
  config: string
  cache: string
  state: string
  bin: string
  log: string
  repos: string
}) {
  registerProcessProfile([
    input.data,
    input.config,
    input.cache,
    input.state,
    path.dirname(input.state),
    input.bin,
    input.log,
    input.repos,
    path.join(input.home, ".kilocode"),
    path.join(input.home, ".config", "kilo"),
  ])
  const key = process.platform === "win32" ? path.normalize(input.state).toLowerCase() : path.normalize(input.state)
  const owner = owners.get(key)
  if (!owner) throw new Error("Global state scope lacks its process lifetime owner")
  states.add(process.platform === "win32" ? owner.path.toLowerCase() : owner.path)
  if (states.size > 128) throw new Error("Source state scope inventory exceeds its bound")
  const paths = {
    data: input.data,
    config: input.config,
    cache: input.cache,
    state: input.state,
    stateParent: path.dirname(input.state),
    bin: input.bin,
    log: input.log,
    repos: input.repos,
    homeKilocode: path.join(input.home, ".kilocode"),
    homeConfigKilo: path.join(input.home, ".config", "kilo"),
  }
  const value = GlobalScopes.parse(
    Object.fromEntries(
      Object.entries(paths).map(([role, file]) => {
        const key = process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)
        const owner = owners.get(key)
        if (!owner) throw new Error("Global namespace lacks its process lifetime owner")
        return [role, owner.path]
      }),
    ),
  )
  const identity = JSON.stringify(
    Object.fromEntries(
      Object.entries(value).map(([role, file]) => [role, process.platform === "win32" ? file.toLowerCase() : file]),
    ),
  )
  if (!globals.has(identity)) globals.set(identity, Object.freeze(value))
  if (globals.size > 128) throw new Error("Source Global scope inventory exceeds its bound")
}

/** Historical roles come only from realized Global graphs with actual lifetime owners. */
export function sourceScopes() {
  const evidence = (() => {
    try {
      return { configs: ConfigIntent.snapshot(), configStatus: "complete" as const }
    } catch (err) {
      if (!(err instanceof ConfigIntentRefusal)) throw err
      return {
        configs: [],
        configStatus: err.code === "metadata-overflow" ? ("overflow" as const) : ("uncertain" as const),
        configReason: err.code,
      }
    }
  })()
  return freeze(
    SourceScopes.parse({
      version: 4,
      states: [...states].sort(),
      globals: [...globals.keys()].sort().map((key) => globals.get(key)!),
      ...evidence,
    }),
  )
}

/** Called after all graphs, native resources, logs and last cooperative receipts have settled. */
export function closeProcessProfile(): Promise<void> {
  if (closing) return closing
  const result = Promise.withResolvers<void>()
  closing = result.promise // Fence synchronous constructors before any release.
  void ConfigIntent.retire().then(
    () => {
      for (const owner of owners.values()) {
        try {
          owner.release()
        } catch (err) {
          failures.push(err)
        }
      }
      if (failures.length) result.reject(new AggregateError(failures, "Process profile ownership retirement failed"))
      if (!failures.length) {
        owners.clear()
        result.resolve()
      }
    },
    (err: unknown) => result.reject(err),
  )
  return closing
}

export function processProfileSnapshot() {
  return Object.freeze({
    roots: Object.freeze([...owners.values()].map((owner) => owner.path)),
    terminal: !!closing,
    failures: failures.length,
    processLocal: true,
    portableCaptureAuthorized: false,
  })
}
