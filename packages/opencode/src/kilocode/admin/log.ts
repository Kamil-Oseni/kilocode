import { Context, Effect, Layer, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { RayaAdmin } from "./registry"

export namespace RayaAdminLog {
  export const Severity = Schema.Literals(["info", "warning", "error"])
  export type Severity = typeof Severity.Type

  export const Code = Schema.Literals([
    "probe.started",
    "probe.completed",
    "probe.failed",
    "connection.changed",
    "storage.checked",
    "recovery.detected",
    "host.changed",
    "delivery.started",
    "delivery.completed",
    "delivery.failed",
    "delivery.recovered",
    "contact.authorized",
    "contact.revoked",
  ])
  export type Code = typeof Code.Type

  const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
  const Duration = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 600_000 }))
  const Version = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^\d{1,4}\.\d{1,4}\.\d{1,8}$/))
  const State = Schema.Union([RayaAdmin.Status, Schema.Literals(["connecting", "connected", "disconnected", "error"])])
  const Source = Schema.Union([RayaAdmin.Subsystem, Schema.Literals(["registry", "host"])])

  export const Fields = Schema.Struct({
    durationMs: Schema.optional(Duration),
    count: Schema.optional(Count),
    attempt: Schema.optional(Count),
    generation: Schema.optional(Count),
    state: Schema.optional(State),
    reason: Schema.optional(RayaAdmin.Reason),
    source: Schema.optional(Source),
    version: Schema.optional(Version),
    channel: Schema.optional(Schema.Literals(["raya", "email", "telegram", "whatsapp"])),
    scope: Schema.optional(Schema.Literals(["global", "agent", "organization"])),
  })
  export type Fields = typeof Fields.Type

  export const Input = Schema.Struct({
    subsystem: RayaAdmin.Subsystem,
    severity: Severity,
    code: Code,
    fields: Schema.optional(Fields),
  })
  export type Input = typeof Input.Type

  const Time = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
  export const Entry = Schema.Struct({
    seq: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    at: Time,
    ...Input.fields,
  })
  export type Entry = typeof Entry.Type

  export type Query = { after?: number; limit?: number }
  export interface Interface {
    write: (value: unknown) => Effect.Effect<Entry | undefined>
    list: (query?: Query) => Effect.Effect<Entry[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@kilocode/RayaAdminLog") {}

  export function make(opts: { capacity?: number; clock?: () => number } = {}) {
    const requested = Number.isInteger(opts.capacity) ? (opts.capacity ?? 256) : 256
    const capacity = Math.max(1, Math.min(requested, 256))
    const clock = opts.clock ?? Date.now
    const entries: Entry[] = []
    let seq = 0

    const write = (value: unknown): Entry | undefined => {
      const input = Option.getOrUndefined(Schema.decodeUnknownOption(Input)(value))
      if (!input) return undefined
      const at = clock()
      if (!Number.isFinite(at) || at < 0 || seq >= Number.MAX_SAFE_INTEGER) return undefined
      const entry = Schema.decodeUnknownSync(Entry)({ seq: ++seq, at, ...input })
      entries.push(entry)
      if (entries.length > capacity) entries.splice(0, entries.length - capacity)
      return copy(entry)
    }

    const list = (query: Query = {}): Entry[] => {
      const after = Number.isInteger(query.after) && (query.after ?? -1) >= 0 ? query.after : undefined
      const requested = Number.isInteger(query.limit) ? (query.limit ?? 100) : 100
      const limit = Math.max(1, Math.min(requested, 100))
      const found =
        after === undefined ? entries.slice(-limit) : entries.filter((entry) => entry.seq > after).slice(0, limit)
      return found.map(copy)
    }

    return { write, list }
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const stores = yield* InstanceState.make(() => Effect.sync(() => make()))
      return Service.of({
        write: (value) => InstanceState.use(stores, (store) => store.write(value)),
        list: (query) => InstanceState.use(stores, (store) => store.list(query)),
      })
    }),
  )

  function copy(entry: Entry): Entry {
    return { ...entry, ...(entry.fields ? { fields: { ...entry.fields } } : {}) }
  }
}
