const found = new Set<string>()

export namespace EnvAlias {
  /** Read a Raya environment name while retaining the Kilo name as a compatibility fallback. */
  export function read(raya: string, kilo: string, env: NodeJS.ProcessEnv = process.env) {
    const next = env[raya]
    const legacy = env[kilo]
    if (next !== undefined && legacy !== undefined && next !== legacy) found.add(`${raya}/${kilo}`)
    return next !== undefined ? next : legacy
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
