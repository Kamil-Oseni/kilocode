const found = new Set<string>()

export namespace EnvAlias {
  /** Read a Raya environment name while retaining the Kilo name as a compatibility fallback. */
  export function read(raya: string, kilo: string, env: NodeJS.ProcessEnv = process.env) {
    const next = env[raya]
    const legacy = env[kilo]
    if (next !== undefined && legacy !== undefined && next !== legacy) found.add(`${raya}/${kilo}`)
    return next !== undefined ? next : legacy
  }

  /** Return and clear value-free conflict labels for logging after startup logging is ready. */
  export function conflicts() {
    const result = [...found].sort()
    found.clear()
    return result
  }
}
