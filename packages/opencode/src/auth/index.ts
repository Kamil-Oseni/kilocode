import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Telemetry } from "@kilocode/kilo-telemetry" // kilocode_change
import { EnvAlias } from "@opencode-ai/core/kilocode/env-alias" // kilocode_change
import { CredentialPublication } from "@opencode-ai/core/kilocode/credential-publication" // kilocode_change - shared canonical auth publication
import { ProfileWriterLive } from "@/kilocode/migration/writer-live" // kilocode_change - profile migration admission

export const OAUTH_DUMMY_KEY = "kilo-oauth-dummy-key" // kilocode_change

const filepath = () => path.join(Global.Path.data, "auth.json") // kilocode_change - resolve the active profile per operation

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const make = (
  admission: ProfileWriterLive.Admission = ProfileWriterLive.auth, // kilocode_change - injectable admission
) =>
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    // kilocode_change start - late-bound path and Raya environment compatibility
    const load = Effect.fn("Auth.load")(function* (target: string, strict = false) {
      const content = EnvAlias.read("RAYA_AUTH_CONTENT", "KILO_AUTH_CONTENT")
      if (content) {
        try {
          return JSON.parse(content)
        } catch {
          yield* Effect.logWarning("Invalid inline auth JSON; falling back to the existing auth store")
        }
      }
      const data = (yield* strict
        ? fsys.readJson(target).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({})),
            Effect.mapError(fail("Failed to read auth data")),
          )
        : fsys.readJson(target).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })
    // kilocode_change end

    const all = Effect.fn("Auth.all")(() => load(filepath())) // kilocode_change - late-bound profile path

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* admission.run(
        Effect.suspend(
          () =>
            CredentialPublication.run(filepath(), (channel) =>
              Effect.gen(function* () {
                // kilocode_change - common lock before reads and publication
                const target = channel.file // kilocode_change - selected canonical auth path
                const norm = key.replace(/\/+$/, "")
                const data = yield* load(target, true)
                if (norm !== key) delete data[key]
                delete data[norm + "/"]
                yield* channel.write({ ...data, [norm]: info }) // kilocode_change - retain raw native failure before typed mapping
              }),
            ).pipe(Effect.catchDefect((cause) => Effect.fail(fail("Failed to write auth data")(cause)))), // kilocode_change - map only after publication retained its raw defect
        ), // kilocode_change - native atomic write remains joined
      ) // kilocode_change - admit the complete read-modify-write
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      yield* admission.run(
        Effect.suspend(
          () =>
            CredentialPublication.run(filepath(), (channel) =>
              Effect.gen(function* () {
                // kilocode_change - common lock before reads and publication
                const target = channel.file // kilocode_change - selected canonical auth path
                const norm = key.replace(/\/+$/, "")
                const data = yield* load(target, true)
                delete data[key]
                delete data[norm]
                yield* channel.write(data) // kilocode_change - retain raw native failure before typed mapping
              }),
            ).pipe(Effect.catchDefect((cause) => Effect.fail(fail("Failed to write auth data")(cause)))), // kilocode_change - map only after publication retained its raw defect
        ), // kilocode_change - native atomic write remains joined
      ) // kilocode_change - admit the complete read-modify-write

      // kilocode_change start - Track logout and reset telemetry identity for Kilo after the durable mutation
      if (key === "kilo") {
        yield* Effect.promise(() => Telemetry.updateIdentity(null))
      }
      Telemetry.trackAuthLogout(key)
      // kilocode_change end
    })

    return Service.of({ get, all, set, remove })
  })

const layer = Layer.effect(Service, make()) // kilocode_change - process-lifetime admission

export const layerWithAdmission = (admission: ProfileWriterLive.Admission) => Layer.effect(Service, make(admission)) // kilocode_change - tests

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })
export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer)) // kilocode_change - legacy Kilo runtime compatibility

export * as Auth from "."
