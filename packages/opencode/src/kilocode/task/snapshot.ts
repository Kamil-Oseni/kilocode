import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Cause, Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { SessionID } from "@/session/schema"
import { Outputs } from "./output-scope"
import { Reference } from "./job-contract"

export namespace RayaTaskSnapshot {
  export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskSnapshot.Invalid", {
    message: Schema.String,
  }) {}
  const Base = {
    runID: Schema.String.check(Schema.isMinLength(1)),
    sessionID: Schema.optional(SessionID),
    agentID: Schema.String.check(Schema.isMinLength(1)),
    at: Schema.Finite,
    definition: RayaTask.Agent,
    objective: Schema.String,
    outputs: Schema.optional(Outputs),
    contract: Schema.optional(Reference),
  }
  const Policy = Schema.Struct({
    organizationID: Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/)),
    organizationRevision: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  })
  export const Current = Schema.Struct({
    version: Schema.Literals([2, 3]),
    ...Base,
    organizationPolicy: Schema.optional(Policy),
  }).check(
    Schema.makeFilter((value) =>
      (value.version === 3) === (value.contract !== undefined)
        ? undefined
        : "Contracted startup snapshots require version 3 and a contract reference.",
    ),
  )
  export const Info = Schema.Struct({
    version: Schema.Literals([1, 2, 3]),
    ...Base,
    organizationPolicy: Schema.optional(Policy),
  }).check(
    Schema.makeFilter((value) =>
      (value.version === 3) === (value.contract !== undefined)
        ? undefined
        : "Contracted startup snapshots require version 3 and a contract reference.",
    ),
  )
  const key = (id: string) => ["raya", "agent-starts", createHash("sha256").update(id).digest("hex")]

  export function make(input: { storage: Pick<Storage.Interface, "create" | "read"> }) {
    const find = Effect.fn("RayaTaskSnapshot.find")(function* (id: string) {
      const raw = yield* input.storage.read(key(id)).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause).pipe(Effect.orDie)
            : Effect.fail(new Invalid({ message: "The saved startup snapshot could not be read." })),
        ),
      )
      if (raw === undefined) return undefined
      const snapshot = yield* Schema.decodeUnknownEffect(Info)(raw).pipe(
        Effect.mapError(() => new Invalid({ message: "The saved startup snapshot is invalid." })),
      )
      if (snapshot.runID !== id || snapshot.agentID !== snapshot.definition.id)
        return yield* new Invalid({ message: "Routine snapshot identity mismatch." })
      return snapshot
    })
    const get = Effect.fn("RayaTaskSnapshot.get")(function* (id: string) {
      const snapshot = yield* find(id).pipe(Effect.orDie)
      if (!snapshot) return yield* Effect.die(new Error("No startup snapshot was saved for this run."))
      return snapshot
    })
    const save = Effect.fn("RayaTaskSnapshot.save")(function* (value: typeof Info.Type) {
      const parsed = yield* Schema.decodeUnknownEffect(Info)(value).pipe(Effect.orDie)
      if (parsed.agentID !== parsed.definition.id)
        return yield* Effect.die(new Error("Routine snapshot identity mismatch."))
      const definition = { ...parsed.definition }
      delete definition.nextRun
      delete definition.execution
      const snapshot = yield* Schema.decodeUnknownEffect(Current)(
        JSON.parse(
          JSON.stringify({
            ...parsed,
            version: parsed.version === 3 ? 3 : 2,
            definition,
            ...(parsed.version >= 2 && parsed.organizationPolicy
              ? { organizationPolicy: parsed.organizationPolicy }
              : {}),
          }),
        ),
      ).pipe(Effect.orDie)
      if (yield* input.storage.create(key(parsed.runID), snapshot).pipe(Effect.orDie)) return snapshot
      const previous = yield* get(parsed.runID)
      if (!isDeepStrictEqual(previous, snapshot))
        return yield* Effect.die(new Error("A routine startup snapshot cannot be replaced."))
      return previous
    })
    return { get, save, find }
  }
}
