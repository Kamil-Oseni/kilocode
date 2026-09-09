import { createHash } from "node:crypto"
import { Cause, Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { owner, stopped } from "./owner"
import { starting } from "./claim"

const Owner = Schema.Struct({ host: Schema.String, pid: Schema.Number })
const Record = Schema.Struct({
  version: Schema.Literal(1),
  agentID: Schema.String,
  id: Schema.String,
  at: Schema.Number,
  phase: Schema.Literals(["claimed", "session-created"]),
  owner: Owner,
  sessionID: Schema.optional(SessionID),
  trigger: Schema.optional(Schema.Unknown),
})
const Permit = Schema.Struct({ id: Schema.String, owner: Owner, settled: Schema.optional(Schema.Boolean) })
type Store = Pick<Storage.Interface, "create" | "replace" | "remove"> & {
  read: (key: string[]) => ReturnType<Storage.Interface["read"]>
}
const hash = (id: string) => createHash("sha256").update(id).digest("hex")

/** Read-only projection; a retained claim never authorizes another startup. */
export const inspect = Effect.fn("RayaTaskClaim.inspect")(function* (storage: Store, id: string) {
  const raw = yield* storage.read(["raya", "agent-claims", hash(id)]).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(cause).pipe(Effect.orDie) : Effect.succeed(null),
    ),
  )
  if (raw === undefined) return undefined
  const record = yield* Schema.decodeUnknownEffect(Record)(raw).pipe(Effect.orElseSucceed(() => undefined))
  if (!record || record.agentID !== id || !record.id) return { state: "recovery" as const }
  const current = owner()
  const local = record.owner.host === current.host && record.owner.pid === current.pid && starting(record.id)
  return {
    state: local ? ("starting" as const) : ("recovery" as const),
    runID: record.id,
    ...(record.phase === "session-created" && record.sessionID ? { sessionID: record.sessionID } : {}),
  }
})

/** Inspection must not start work. Only settled or stopped recovery owners permit a successor. */
export function recover<E, R, F = never, S = never>(
  storage: Store,
  id: string,
  inspect: (record: typeof Record.Type) => Effect.Effect<boolean, E, R>,
  repair?: (record: typeof Record.Type) => Effect.Effect<boolean, F, S>,
) {
  const read = (key: string[]) =>
    storage.read(key).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      Effect.orDie,
    )
  const decode = (value: unknown) =>
    Schema.decodeUnknownEffect(Record)(value).pipe(Effect.orElseSucceed(() => undefined))
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const key = ["raya", "agent-claims", hash(id)]
      const record = yield* read(key).pipe(Effect.flatMap(decode))
      if (!record || record.agentID !== id || !stopped(record.owner)) return false
      if (!(yield* inspect(record))) return false
      let prior = record.id
      for (let depth = 0; depth < 64; depth++) {
        const path = ["raya", "agent-recovery", hash(id), hash(prior)]
        const permit = { id: crypto.randomUUID(), owner: owner(), claim: record }
        if (!(yield* storage.create(path, permit).pipe(Effect.orDie))) {
          const previous = yield* read(path).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Permit)),
            Effect.orElseSucceed(() => undefined),
          )
          if (!previous || (!previous.settled && !stopped(previous.owner))) return false
          prior = previous.id
          continue
        }
        return yield* Effect.gen(function* () {
          const current = yield* read(key).pipe(Effect.flatMap(decode))
          // Immutable permit ancestry excludes other recovery workers. A new startup has a different claim ID.
          if (JSON.stringify(current) !== JSON.stringify(record) || !stopped(record.owner)) return false
          if (!(yield* inspect(record))) return false
          if (repair && !(yield* repair(record))) return false
          yield* storage.remove(key).pipe(Effect.orDie)
          return true
        }).pipe(Effect.ensuring(storage.replace(path, { ...permit, settled: true }).pipe(Effect.orDie)))
      }
      return false
    }),
  )
}
