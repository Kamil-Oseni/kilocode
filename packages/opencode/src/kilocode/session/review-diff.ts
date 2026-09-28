import path from "node:path"
import { Effect } from "effect"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { Snapshot } from "@/snapshot"
import type { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { boundaries, canonical } from "./review-boundaries"
import { project } from "./review-patches"
import { ReviewConflict } from "./review-revision"
import { active, read } from "./review-undo"
import { resolve, root, run, type Owner } from "./review-workspace"

type Span = { owner: Owner; file: string; start: string; finish: string; first: string; last: string }

/** Preserve a different session directory's immutable snapshot origin before merging its raw diff. */
export function provenance(diffs: readonly Snapshot.FileDiff[], messages: readonly MessageV2.WithParts[]) {
  if (!diffs.length) return []
  const origins = new Map<string, string>()
  const claims = new Set<string>()
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    const directory = root(message.info.path.cwd, message.info.path.root)
    for (const part of message.parts) {
      if (part.type !== "patch") continue
      origins.set(canonical(directory), directory)
      for (const file of part.files) claims.add(canonical(file, directory))
    }
  }
  const [directory] = origins.values()
  if (origins.size !== 1 || !directory)
    throw new ReviewConflict({ message: "A worker's file changes do not have a verified workspace origin." })
  return diffs.map((diff) => {
    if (!diff.file || !claims.has(canonical(diff.file, directory)))
      throw new ReviewConflict({ message: "A worker's file changes do not have a verified workspace origin." })
    return { ...diff, file: path.resolve(directory, diff.file) }
  })
}

/** Reconstruct review scope across parent and child steps after the last Keep. */
export const spans = Effect.fn("ReviewDiff.spans")(function* (
  snap: Snapshot.Interface,
  storage: Storage.Interface,
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const ctx = yield* InstanceState.context
  const workspace = canonical(root(ctx.directory, ctx.worktree))
  const kept = yield* boundaries(storage, sessions, sessionID)
  const undone = yield* read(storage, sessions, sessionID)
  const result = new Map<string, Span>()
  const queue = [sessionID]
  const visited = new Set<SessionID>()
  const groups: { id: SessionID; messages: MessageV2.WithParts[] }[] = []
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const messages = yield* sessions.messages({ sessionID: id }).pipe(Effect.orDie)
    for (const message of messages) {
      const blind = message.parts.some(
        (part) => part.type === "tool" && ["bash", "edit", "write", "apply_patch", "multiedit"].includes(part.tool),
      )
      if (
        blind &&
        (!message.parts.some((part) => part.type === "step-start" && !!part.snapshot) ||
          !message.parts.some((part) => part.type === "step-finish" && !!part.snapshot))
      )
        return yield* Effect.die(
          new ReviewConflict({
            message:
              "A file operation ran without a completed snapshot. Review is unavailable until the files are reconciled.",
          }),
        )
      if (
        blind &&
        message.info.role === "assistant" &&
        canonical(root(message.info.path.cwd, message.info.path.root)) !== workspace &&
        !message.parts.some((part) => part.type === "patch")
      )
        return yield* Effect.die(
          new ReviewConflict({
            message: "A worker's file operation has no verified patch scope. Reconcile its workspace before reviewing.",
          }),
        )
    }
    groups.push({ id, messages })
    for (const child of yield* sessions.children(id)) queue.push(child.id)
  }
  // Reject an incomplete descendant before projecting any historical patch. Otherwise
  // each review refresh queues Git work that cannot change the refusal.
  for (const group of groups) {
    const pending = group.messages.filter(
      (message) =>
        message.info.role === "assistant" &&
        message.parts.some(
          (part) =>
            part.type === "patch" &&
            part.files.some((file) => {
              const origin =
                message.info.role === "assistant" ? root(message.info.path.cwd, message.info.path.root) : ""
              const key = canonical(file, origin)
              return (
                (!kept[key] || message.info.id > kept[key]) && !undone.get(key)?.has(`${message.info.id}:${part.id}`)
              )
            }),
        ),
    )
    if (!pending.length) continue
    const owner = yield* resolve(sessions, group.id, pending)
    const messages = active(yield* run(owner, project(snap, pending, owner.root)), owner.root, undone)
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
          const key = canonical(file, owner.root)
          if (kept[key] && message.info.id <= kept[key]) continue
          const prior = result.get(key)
          result.set(key, {
            owner,
            file: path.resolve(owner.root, file),
            start: prior && prior.first < order ? prior.start : start,
            finish: prior && prior.last > order ? prior.finish : finish,
            first: prior && prior.first < order ? prior.first : order,
            last: prior && prior.last > order ? prior.last : order,
          })
        }
      }
    }
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
  const ctx = yield* InstanceState.context
  const directory = root(ctx.directory, ctx.worktree)
  const kept = yield* boundaries(storage, sessions, sessionID)
  const undone = yield* read(storage, sessions, sessionID)
  const scope = yield* spans(snap, storage, sessions, sessionID)
  const result = new Map(
    diffs
      .filter(
        (diff) => !!diff.file && !kept[canonical(diff.file, directory)] && !undone.has(canonical(diff.file, directory)),
      )
      .map((diff) => [canonical(diff.file!, directory), diff]),
  )
  for (const [key, span] of scope) {
    if (!(yield* run(span.owner, snap.matches([{ hash: span.finish, files: [span.file] }])))) {
      // A full-file Undo restores the first pending edit's starting snapshot.
      // Historical child diffs can still name that edit after the restore.
      if (yield* run(span.owner, snap.matches([{ hash: span.start, files: [span.file] }]))) {
        result.delete(key)
        continue
      }
      return yield* Effect.die(
        new ReviewConflict({
          message:
            "The workspace no longer matches the reviewed snapshot. Refresh or reconcile the files before reviewing.",
        }),
      )
    }
    const batch = yield* run(span.owner, snap.diffFull(span.start, span.finish))
    const diff = batch.find((item) => item.file && canonical(item.file, span.owner.root) === key)
    if (diff)
      result.set(key, {
        ...diff,
        file:
          canonical(span.owner.root) === canonical(directory) && canonical(owner.directory) === canonical(directory)
            ? diff.file
            : span.file,
      })
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
  const ctx = yield* InstanceState.context
  const key = canonical(file, root(ctx.directory, ctx.worktree))
  const span = (yield* spans(snap, storage, sessions, sessionID)).get(key)
  if (!span) {
    const kept = yield* boundaries(storage, sessions, sessionID)
    return kept[key] ? { matched: true as const, diff: undefined } : { matched: false as const }
  }
  if (!(yield* run(span.owner, snap.matches([{ hash: span.finish, files: [span.file] }])))) {
    if (yield* run(span.owner, snap.matches([{ hash: span.start, files: [span.file] }])))
      return { matched: true as const, diff: undefined }
    return yield* Effect.die(
      new ReviewConflict({
        message:
          "The workspace no longer matches the reviewed snapshot. Refresh or reconcile the files before reviewing.",
      }),
    )
  }
  const diff = yield* run(
    span.owner,
    snap
      .diffFile(span.start, span.finish, path.relative(span.owner.root, span.file).replaceAll("\\", "/"))
      .pipe(Effect.provideService(InstanceRef, { ...span.owner.ctx, directory: span.owner.root })),
  )
  return {
    matched: true as const,
    diff: diff && { ...diff, file: path.isAbsolute(file) ? span.file : diff.file },
  }
})
