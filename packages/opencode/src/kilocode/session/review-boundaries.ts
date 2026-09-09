import path from "node:path"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"

export function canonical(file: string, directory = process.cwd()) {
  const absolute = path.resolve(directory, file).replaceAll("\\", "/")
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}

/** Read the selected subtree and its ancestors without importing unrelated sibling boundaries. */
export const boundaries = Effect.fn("ReviewBoundaries.read")(function* (
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const result: Record<string, string> = {}
  const queue = [{ id: sessionID, descendants: true }]
  const visited = new Set<SessionID>()
  while (queue.length) {
    const current = queue.shift()!
    const id = current.id
    if (visited.has(id)) continue
    visited.add(id)
    const kept = yield* storage.read<unknown>(["session_kept", id]).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed({})),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))),
      Effect.orDie,
    )
    const session = yield* sessions
      .get(id)
      .pipe(
        Effect.catchTag("NotFoundError", (error) =>
          id === sessionID && !Object.keys(kept).length ? Effect.succeed(undefined) : Effect.die(error),
        ),
      )
    if (Object.keys(kept).length) {
      if (!session) return yield* Effect.die(new Error("Cannot resolve the session owning an accepted review boundary"))
      for (const [file, boundary] of Object.entries(kept)) {
        const key = canonical(file, session.directory)
        if (!result[key] || result[key] < boundary) result[key] = boundary
      }
    }
    if (session?.parentID) queue.push({ id: session.parentID, descendants: false })
    if (current.descendants)
      for (const child of yield* sessions.children(id)) queue.push({ id: child.id, descendants: true })
  }
  return result
})
