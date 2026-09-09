import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Cause, Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."

export namespace RayaTaskSnapshot {
  export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaTaskSnapshot.Invalid", {
    message: Schema.String,
  }) {}
  export const Info = Schema.Struct({
    version: Schema.Literal(1),
    runID: Schema.String.check(Schema.isMinLength(1)),
    agentID: Schema.String.check(Schema.isMinLength(1)),
    at: Schema.Finite,
    definition: RayaTask.Agent,
    objective: Schema.String,
  })
  const key = (id: string) => ["raya", "agent-starts", createHash("sha256").update(id).digest("hex")]

  export function make(input: { storage: Storage.Interface }) {
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
      const snapshot = yield* Schema.decodeUnknownEffect(Info)(
        JSON.parse(JSON.stringify({ ...parsed, definition })),
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
