const found = new Set<string>()

export namespace EnvAlias {
  export class Conflict extends Error {
    readonly raya: string
    readonly kilo: string

    constructor(raya: string, kilo: string) {
      super(`Conflicting environment variables: ${raya} and ${kilo}`)
      this.name = "EnvAliasConflictError"
      this.raya = raya
      this.kilo = kilo
    }
  }

  /** Read a Raya environment name while retaining the Kilo name as a compatibility fallback. */
  export function read(raya: string, kilo: string, env: NodeJS.ProcessEnv = process.env) {
    return readValues(raya, kilo, env[raya], env[kilo])
  }

  /** Resolve injected ordinary values with Raya precedence and value-free conflict diagnostics. */
  export function readValues(raya: string, kilo: string, next: string | undefined, legacy: string | undefined) {
    if (next !== undefined && legacy !== undefined && next !== legacy) found.add(`${raya}/${kilo}`)
    return next !== undefined ? next : legacy
  }

  /** Resolve injected safety-sensitive values while retaining value-free conflict diagnostics. */
  export function enabledValues(raya: string, kilo: string, next: string | undefined, legacy: string | undefined) {
    if (next !== undefined && legacy !== undefined && next !== legacy) found.add(`${raya}/${kilo}`)
    return [next, legacy].some((value) => {
      const normalized = value?.toLowerCase()
      return normalized === "true" || normalized === "1"
    })
  }

  /** Enable a safety-sensitive boolean when either compatibility name is truthy. */
  export function enabled(raya: string, kilo: string, env: NodeJS.ProcessEnv = process.env) {
    return enabledValues(raya, kilo, env[raya], env[kilo])
  }

  /** Resolve sensitive input without silently choosing between conflicting aliases. */
  export function credential(
    explicit: string | undefined,
    raya: string,
    kilo: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (explicit !== undefined) return explicit
    const next = env[raya]
    const legacy = env[kilo]
    if (next !== undefined && legacy !== undefined && next !== legacy) throw new Conflict(raya, kilo)
    return next ?? legacy
  }

  /** Update both names so mutable legacy flag accessors keep one effective value. */
  export function write(raya: string, kilo: string, value: string | undefined, env: NodeJS.ProcessEnv = process.env) {
    if (value !== undefined) {
      env[raya] = value
      env[kilo] = value
      return
    }
    delete env[raya]
    delete env[kilo]
  }

  /** Return and clear value-free conflict labels for logging after startup logging is ready. */
  export function conflicts() {
    const result = [...found].sort()
    found.clear()
    return result
  }
}
