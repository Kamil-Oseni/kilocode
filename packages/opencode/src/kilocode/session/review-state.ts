import { Effect, Schema } from "effect"
import { Snapshot } from "@/snapshot"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { revision } from "./review-revision"
import { boundaries as read } from "./review-boundaries"
import { group, root } from "./review-workspace"
import { canonical } from "./review-boundaries"
import { active, read as undone } from "./review-undo"

export const ReviewDiff = Snapshot.FileDiff.mapFields((fields) => ({
  ...fields,
  generation: Schema.optional(
    Schema.String.annotate({
      description: "Opaque identity of the latest persisted agent patch event for this file.",
    }),
  ),
  reviewed: Schema.optional(
    Schema.String.annotate({
      description: "Accepted revision fingerprint, or an empty string when review is pending.",
    }),
  ),
})).annotate({ identifier: "ReviewFileDiff" })

/** Project persisted acceptance onto current content; never trust client dismissal state. */
export const reviewed = Effect.fn("ReviewState.reviewed")(function* (
  snap: Snapshot.Interface,
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
  diffs: readonly Snapshot.FileDiff[],
) {
  if (!diffs.length) return []
  const kept = yield* read(storage, sessions, sessionID)
  const history = yield* undone(storage, sessions, sessionID)
  const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const normalize = (file: string) => canonical(file, session.directory)
  const boundaries = new Map(Object.entries(kept).map(([file, id]) => [normalize(file), id]))
  const latest = new Map<string, { message: string; generation: string }>()
  const visited = new Set<string>()
  const queue = [sessionID]
  const wanted = new Set(diffs.flatMap((diff) => (diff.file ? [normalize(diff.file)] : [])))
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const child of yield* sessions.children(id)) queue.push(child.id)
    const saved = yield* sessions.messages({ sessionID: id }).pipe(Effect.orDie)
    if (
      !saved.some(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.some(
            (part) =>
              part.type === "patch" &&
              part.files.some((file) =>
                wanted.has(
                  canonical(
                    file,
                    message.info.role === "assistant"
                      ? root(message.info.path.cwd, message.info.path.root)
                      : session.directory,
                  ),
                ),
              ),
          ),
      )
    )
      continue
    const projected = yield* group(snap, sessions, id)
    const messages = active(projected.messages, projected.owner.root, history)
    for (const message of messages)
      for (const part of message.parts) {
        if (part.type !== "patch") continue
        const generation = `${message.info.id}:${part.id}`
        for (const file of part.files) {
          const key = normalize(file)
          if (!latest.has(key) || latest.get(key)!.generation < generation)
            latest.set(key, { message: message.info.id, generation })
        }
      }
  }
  return diffs.map((diff) => {
    const key = diff.file && normalize(diff.file)
    const last = key && latest.get(key)
    const boundary = key && boundaries.get(key)
    const current = { ...diff, ...(last ? { generation: last.generation } : {}) }
    return { ...current, reviewed: last && boundary && last.message <= boundary ? revision(current) : "" }
  })
})
