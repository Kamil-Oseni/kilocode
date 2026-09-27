import { Effect, Schema } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import { canonical } from "./review-boundaries"

const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})

export type Event = { file: string; generation: string }

/** Completed Undo generations are shared across a selected session and its review tree. */
export const read = Effect.fn("ReviewUndo.read")(function* (
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const result = new Map<string, Set<string>>()
  const queue = [{ id: sessionID, descendants: true }]
  const visited = new Set<SessionID>()
  while (queue.length) {
    const current = queue.shift()!
    if (visited.has(current.id)) continue
    visited.add(current.id)
    const saved = yield* storage.read<unknown>(["session_undo", current.id]).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed({ version: 1, files: {} })),
      Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
      Effect.orDie,
    )
    for (const [file, generations] of Object.entries(saved.files)) {
      const known = result.get(file) ?? new Set<string>()
      for (const generation of generations) known.add(generation)
      result.set(file, known)
    }
    const owner = yield* sessions.get(current.id).pipe(Effect.orDie)
    if (owner.parentID) queue.push({ id: owner.parentID, descendants: false })
    if (current.descendants)
      for (const child of yield* sessions.children(current.id)) queue.push({ id: child.id, descendants: true })
  }
  return result
})

/** Project immutable patch history through completed Undo decisions. */
export function active(messages: readonly MessageV2.WithParts[], directory: string, undone: Map<string, Set<string>>) {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "patch") return part
      const generation = `${message.info.id}:${part.id}`
      return {
        ...part,
        files: part.files.filter((file) => !undone.get(canonical(file, directory))?.has(generation)),
      }
    }),
  }))
}

/** The workspace review gate serializes this read/merge/write with other review actions. */
export const append = Effect.fn("ReviewUndo.append")(function* (
  storage: Storage.Interface,
  sessionID: SessionID,
  directory: string,
  events: readonly Event[],
) {
  if (!events.length) return
  const saved = yield* storage.read<unknown>(["session_undo", sessionID]).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed({ version: 1, files: {} })),
    Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
    Effect.orDie,
  )
  const files = { ...saved.files }
  for (const event of events) {
    const file = canonical(event.file, directory)
    files[file] = [...new Set([...(files[file] ?? []), event.generation])]
  }
  yield* storage.write(["session_undo", sessionID], { version: 1, files }).pipe(Effect.orDie)
})
