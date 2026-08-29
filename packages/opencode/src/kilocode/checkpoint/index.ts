// raya_change - named workspace checkpoints the user can label and jump between
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { Snapshot } from "@/snapshot"
import { SessionID } from "@/session/schema"

export namespace RayaCheckpoint {
  export const Info = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    hash: Schema.String,
    createdAt: Schema.Number,
  })
  export type Info = typeof Info.Type

  export const List = Schema.Array(Info)

  export const CreatePayload = Schema.Struct({ name: Schema.optional(Schema.String) })

  type Store = Pick<Storage.Interface, "read" | "write">
  type Snap = Pick<Snapshot.Interface, "track" | "restore">

  const key = (sessionID: SessionID) => ["raya", "checkpoint", sessionID]
  const decode = Schema.decodeUnknownEffect(List)

  export function make(deps: { storage: Store; snapshots: Snap }) {
    const read = Effect.fn("RayaCheckpoint.read")(function* (sessionID: SessionID) {
      const raw = yield* deps.storage.read<unknown>(key(sessionID)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed([])),
        Effect.orDie,
      )
      return yield* decode(raw).pipe(Effect.orDie)
    })

    const list = Effect.fn("RayaCheckpoint.list")(function* (sessionID: SessionID) {
      const items = yield* read(sessionID)
      return [...items].sort((a, b) => b.createdAt - a.createdAt)
    })

    // Capture the current workspace as a snapshot and label it. Returns undefined when a
    // snapshot could not be taken (e.g. the snapshot guard disabled tracking for this dir),
    // so the caller can surface that instead of storing an unrestorable checkpoint.
    const create = Effect.fn("RayaCheckpoint.create")(function* (sessionID: SessionID, name?: string) {
      const hash = yield* deps.snapshots.track({ sessionID })
      if (!hash) return undefined
      const label = (name ?? "").trim() || new Date().toLocaleString()
      const info: Info = { id: crypto.randomUUID(), name: label, hash, createdAt: Date.now() }
      const items = yield* read(sessionID)
      yield* deps.storage.write(key(sessionID), [...items, info]).pipe(Effect.orDie)
      return info
    })

    const jump = Effect.fn("RayaCheckpoint.jump")(function* (sessionID: SessionID, id: string) {
      const items = yield* read(sessionID)
      const found = items.find((item) => item.id === id)
      if (!found) return false
      yield* deps.snapshots.restore(found.hash)
      return true
    })

    const remove = Effect.fn("RayaCheckpoint.remove")(function* (sessionID: SessionID, id: string) {
      const items = yield* read(sessionID)
      yield* deps.storage.write(
        key(sessionID),
        items.filter((item) => item.id !== id),
      ).pipe(Effect.orDie)
      return true
    })

    return { list, create, jump, remove }
  }
}
