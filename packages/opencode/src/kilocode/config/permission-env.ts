import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Schema } from "effect"

export namespace PermissionEnv {
  export const raya = "RAYA_PERMISSION"
  export const kilo = "KILO_PERMISSION"

  type Name = typeof raya | typeof kilo
  export type Result = {
    permission: ConfigPermissionV1.Info
    labels: readonly Name[]
  }

  const decode = Schema.decodeUnknownSync(ConfigPermissionV1.Info)

  function invalid(name: string, message: string) {
    return new ConfigErrorV1.InvalidError({ path: name, message })
  }

  function parse(name: Name, text: string) {
    const raw = (() => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw invalid(name, `${name} must contain valid JSON.`)
      }
    })()
    const permission = (() => {
      try {
        return decode(raw, { errors: "all", propertyOrder: "original" })
      } catch {
        throw invalid(name, `${name} must contain a valid permission configuration.`)
      }
    })()
    return { permission, signature: JSON.stringify(permission) }
  }

  export function resolve(env: NodeJS.ProcessEnv = process.env): Result | undefined {
    const next = env[raya]
    const legacy = env[kilo]
    if (next === undefined && legacy === undefined) return undefined

    const current = next === undefined ? undefined : parse(raya, next)
    const prior = legacy === undefined ? undefined : parse(kilo, legacy)
    if (current && prior && current.signature !== prior.signature) {
      throw invalid(`${raya}/${kilo}`, `Conflicting environment variables: ${raya} and ${kilo}.`)
    }

    return {
      permission: (current ?? prior)!.permission,
      labels: [current ? raya : undefined, prior ? kilo : undefined].filter((name): name is Name => name !== undefined),
    }
  }
}
