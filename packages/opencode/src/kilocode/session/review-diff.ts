import path from "node:path"
import { Effect } from "effect"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { Snapshot } from "@/snapshot"
import type { Storage } from "@/storage/storage"
import { boundaries, canonical } from "./review-boundaries"
import { project } from "./review-patches"

type Span = { file: string; start: string; finish: string; first: string; last: string }

/** Reconstruct review scope across parent and child steps after the last Keep. */
export const spans = Effect.fn("ReviewDiff.spans")(function* (
  snap: Snapshot.Interface,
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const kept = yield* boundaries(storage, sessions, sessionID)
  const result = new Map<string, Span>()
  const queue = [sessionID]
  const visited = new Set<SessionID>()
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const owner = yield* sessions.get(id).pipe(Effect.orDie)
    const messages = yield* project(
      snap,
      yield* sessions.messages({ sessionID: id }).pipe(Effect.orDie),
      owner.directory,
    )
    for (const message of messages) {
      let start: string | undefined
      let finish: string | undefined
      for (const part of message.parts) {
        if (part.type === "step-start") {
          start = part.snapshot
          finish = undefined
        }
        if (part.type === "step-finish") finish = part.snapshot
        if (part.type !== "patch" || !start || !finish) continue
        const order = `${message.info.id}:${part.id}`
        for (const file of part.files) {
          const key = canonical(file, owner.directory)
          if (kept[key] && message.info.id <= kept[key]) continue
          const prior = result.get(key)
          result.set(key, {
            file: path.resolve(owner.directory, file),
            start: prior && prior.first < order ? prior.start : start,
            finish: prior && prior.last > order ? prior.finish : finish,
            first: prior && prior.first < order ? prior.first : order,
            last: prior && prior.last > order ? prior.last : order,
          })
        }
      }
    }
    for (const child of yield* sessions.children(id)) queue.push(child.id)
  }
  return result
})

export const overlay = Effect.fn("ReviewDiff.overlay")(function* (
  snap: Snapshot.Interface,
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
  diffs: readonly Snapshot.FileDiff[],
) {
  const owner = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const scope = yield* spans(snap, storage, sessions, sessionID)
  const result = new Map(
    diffs.filter((diff) => !!diff.file).map((diff) => [canonical(diff.file!, owner.directory), diff]),
  )
  for (const [key, span] of scope) {
    const batch = yield* snap.diffFull(span.start, span.finish)
    const diff = batch.find((item) => item.file && canonical(item.file, owner.directory) === key)
    if (diff) result.set(key, diff)
    if (!diff) result.delete(key)
  }
  return [...result.values()]
})

export const detail = Effect.fn("ReviewDiff.detail")(function* (
  snap: Snapshot.Interface,
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
  file: string,
) {
  const owner = yield* sessions.get(sessionID).pipe(Effect.orDie)
  const span = (yield* spans(snap, storage, sessions, sessionID)).get(canonical(file, owner.directory))
  if (!span) return { matched: false as const }
  return {
    matched: true as const,
    diff: yield* snap.diffFile(span.start, span.finish, path.relative(owner.directory, span.file)),
  }
})
