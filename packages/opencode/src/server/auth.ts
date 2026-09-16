export * as ServerAuth from "./auth"

import { EnvAlias } from "@opencode-ai/core/kilocode/env-alias" // kilocode_change
import { Config as EffectConfig, ConfigProvider, Context, Effect, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

// kilocode_change start - resolve credential aliases strictly before a listener is built
export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const values = yield* EffectConfig.all({
          rayaPassword: EffectConfig.string("RAYA_SERVER_PASSWORD").pipe(EffectConfig.option),
          kiloPassword: EffectConfig.string("KILO_SERVER_PASSWORD").pipe(EffectConfig.option),
          rayaUsername: EffectConfig.string("RAYA_SERVER_USERNAME").pipe(EffectConfig.option),
          kiloUsername: EffectConfig.string("KILO_SERVER_USERNAME").pipe(EffectConfig.option),
        })
        return yield* Effect.try({
          try: () =>
            Config.of(
              resolve(undefined, {
                RAYA_SERVER_PASSWORD: Option.getOrUndefined(values.rayaPassword),
                KILO_SERVER_PASSWORD: Option.getOrUndefined(values.kiloPassword),
                RAYA_SERVER_USERNAME: Option.getOrUndefined(values.rayaUsername),
                KILO_SERVER_USERNAME: Option.getOrUndefined(values.kiloUsername),
              }),
            ),
          catch: (cause) =>
            new EffectConfig.ConfigError(
              new ConfigProvider.SourceError({
                message:
                  cause instanceof EnvAlias.Conflict ? cause.message : "Failed to resolve server credential aliases",
              }),
            ),
        })
      }),
    )
  }
}
// kilocode_change end

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

// kilocode_change start - explicit credentials precede strict Raya/Kilo environment aliases
export function resolve(credentials?: Credentials, env: NodeJS.ProcessEnv = process.env): Info {
  const password = EnvAlias.credential(credentials?.password, "RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", env)
  const username = EnvAlias.credential(credentials?.username, "RAYA_SERVER_USERNAME", "KILO_SERVER_USERNAME", env)
  return {
    password: password === undefined ? Option.none() : Option.some(password),
    username: username ?? "kilo",
  }
}

export function header(credentials?: Credentials) {
  const config = resolve(credentials)
  const password = Option.getOrUndefined(config.password)
  if (!password) return undefined

  return `Basic ${Buffer.from(`${config.username}:${password}`).toString("base64")}`
}
// kilocode_change end

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
