import { Cause, Effect } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import type { Snapshot } from "@/snapshot"

export namespace KiloSessionRevert {
  const rollback = <E>(snap: Snapshot.Interface, hash: string, files: string[], cause: Cause.Cause<E>) =>
    restore(snap, hash, files).pipe(
      Effect.matchCauseEffect({
        onFailure: (next) => Effect.failCause(Cause.combine(cause, next)),
        onSuccess: () => Effect.failCause(cause),
      }),
    )

  export function files(messages: MessageV2.WithParts[], rev: NonNullable<Session.Info["revert"]>) {
    const result: string[] = []
    let active = false
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (active && part.type === "patch") result.push(...part.files)
        if (active || msg.info.id !== rev.messageID) continue
        if (rev.partID && part.id !== rev.partID) continue
        active = true
      }
    }
    return [...new Set(result)]
  }

  export const apply = Effect.fn("KiloSessionRevert.apply")(function* <A, E, R>(
    snap: Snapshot.Interface,
    baseline: string | undefined,
    files: string[],
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* effect.pipe(
      Effect.catchCause((cause) => {
        if (!baseline || files.length === 0) return Effect.failCause(cause)
        return rollback(snap, baseline, files, cause)
      }),
    )
  })

  export const restore = Effect.fn("KiloSessionRevert.restore")(function* (
    snap: Snapshot.Interface,
    hash: string,
    files: string[],
  ) {
    if (files.length === 0) return
    yield* snap.revert([{ hash, files }])
  })

  /**
   * Discard every file edit made in the session, restoring each edited file to
   * its state before the session's first edit — without touching messages and
   * without arming a revert boundary (so nothing becomes "redoable").
   *
   * Every "patch" part records the snapshot hash captured *before* that turn's
   * edits. `snap.revert` dedupes by first occurrence per file, so passing all
   * patches in message order restores each file to its earliest baseline. The
   * whole restore is wrapped so a mid-way failure rolls back to the current
   * (edited) state, keeping the operation atomic.
   */
  export const discardAll = Effect.fn("KiloSessionRevert.discardAll")(function* (
    snap: Snapshot.Interface,
    messages: MessageV2.WithParts[],
  ) {
    const patches: Snapshot.Patch[] = []
    for (const msg of messages) for (const part of msg.parts) if (part.type === "patch") patches.push(part)
    const files = [...new Set(patches.flatMap((patch) => patch.files))]
    if (files.length === 0) return { files: [] as string[] }
    const baseline = yield* snap.track()
    if (!baseline)
      return yield* Effect.die(new Error("Cannot discard changes because the current workspace snapshot is unavailable"))
    yield* apply(snap, baseline, files, snap.revert(patches))
    return { files }
  })
}
