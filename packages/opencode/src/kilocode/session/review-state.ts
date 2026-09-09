import path from "node:path"
import { Effect, Schema } from "effect"
import { Snapshot } from "@/snapshot"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { revision } from "./review-revision"
import { boundaries as read } from "./review-boundaries"
import type { Database } from "@opencode-ai/core/database/database"
import { patches } from "./review-history"

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
  db: Database.Interface["db"],
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
  diffs: readonly Snapshot.FileDiff[],
) {
  if (!diffs.length) return []
  const kept = yield* read(storage, sessions, sessionID)
  const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const normalize = (file: string) => {
    const absolute = path.resolve(session.directory, file)
    return process.platform === "win32" ? absolute.toLowerCase() : absolute
  }
  const boundaries = new Map(Object.entries(kept).map(([file, id]) => [normalize(file), id]))
  const latest = new Map<string, { message: string; generation: string }>()
  const visited = new Set<string>()
  const queue = [sessionID]
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const patch of yield* patches(db, id)) {
      for (const file of patch.files) {
        const key = normalize(file)
        if (!latest.has(key) || latest.get(key)!.generation < patch.generation)
          latest.set(key, { message: patch.message, generation: patch.generation })
      }
    }
    for (const child of yield* sessions.children(id)) queue.push(child.id)
  }
  return diffs.map((diff) => {
    const key = diff.file && normalize(diff.file)
    const last = key && latest.get(key)
    const boundary = key && boundaries.get(key)
    const current = { ...diff, ...(last ? { generation: last.generation } : {}) }
    return { ...current, reviewed: last && boundary && last.message <= boundary ? revision(current) : "" }
  })
})
