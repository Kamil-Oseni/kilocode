import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import type { Snapshot } from "@/snapshot"
import { canonical } from "./review-boundaries"
import { revision } from "./review-revision"
import { root, type Identity } from "./review-workspace"

export const Owner = Schema.Struct({
  sessionID: SessionID,
  directory: Schema.String,
  root: Schema.String,
  projectID: Schema.String,
  real: Schema.String,
  dev: Schema.String,
  ino: Schema.String,
  cwdReal: Schema.String,
  cwdDev: Schema.String,
  cwdIno: Schema.String,
})
const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})
export const Witness = Schema.Struct({
  version: Schema.Literal(1),
  owners: Schema.Array(Owner),
  history: Schema.String,
  kept: Schema.String,
  ledgers: Schema.Array(
    Schema.Struct({ sessionID: SessionID, files: Schema.Record(Schema.String, Schema.Array(Schema.String)) }),
  ),
  raw: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  revert: Schema.NullOr(Schema.String),
})
export type Witness = typeof Witness.Type
type Services = { sessions: Session.Interface; storage: Storage.Interface }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const sorted = <A>(value: Record<string, A>) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b))

/** Capture persisted generations independently of the active Undo projection. */
const inspect = Effect.fn("ReviewRecovery.inspect")(function* (
  services: Services,
  sessionID: SessionID,
  files: readonly string[],
) {
  const session = yield* services.sessions.get(sessionID).pipe(Effect.orDie)
  const wanted = new Set(files.map((file) => canonical(file, session.directory)))
  const queue = [sessionID]
  const seen = new Set<SessionID>()
  const history: unknown[] = []
  const kept: unknown[] = []
  const ledgers: { sessionID: SessionID; files: Record<string, readonly string[]> }[] = []
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const owner = yield* services.sessions.get(id).pipe(Effect.orDie)
    history.push([id, owner.parentID ?? null, canonical(owner.directory), owner.projectID])
    for (const child of yield* services.sessions.children(id)) queue.push(child.id)
    const messages = yield* services.sessions.messages({ sessionID: id }).pipe(Effect.orDie)
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      const directory = root(message.info.path.cwd, message.info.path.root)
      const relevant = message.parts.some(
        (part) => part.type === "patch" && part.files.some((file) => wanted.has(canonical(file, directory))),
      )
      if (!relevant) continue
      const selected: unknown[] = []
      let start: unknown
      let finish: unknown
      for (const part of message.parts) {
        if (part.type === "step-start") {
          start = [part.id, part.snapshot ?? null]
          finish = undefined
        }
        if (part.type === "step-finish") finish = [part.id, part.snapshot ?? null]
        if (part.type !== "patch") continue
        const claims = part.files
          .map((file) => canonical(file, directory))
          .filter((file) => wanted.has(file))
          .sort()
        if (claims.length) selected.push([part.id, part.hash, claims, start ?? null, finish ?? null])
        start = undefined
        finish = undefined
      }
      history.push([id, message.info.id, canonical(message.info.path.cwd), canonical(directory), selected])
    }
    const accepted = yield* services.storage.read<unknown>(["session_kept", id]).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed({})),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))),
      Effect.orDie,
    )
    kept.push([
      id,
      sorted(
        Object.fromEntries(
          Object.entries(accepted)
            .map(([file, boundary]) => [canonical(file, owner.directory), boundary])
            .filter(([file]) => wanted.has(file)),
        ),
      ),
    ])
    const ledger = yield* services.storage.read<unknown>(["session_undo", id]).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed({ version: 1, files: {} })),
      Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
      Effect.orDie,
    )
    ledgers.push({
      sessionID: id,
      files: Object.fromEntries(
        Object.entries(ledger.files)
          .filter(([file]) => wanted.has(canonical(file)))
          .map(([file, generations]) => [canonical(file), [...new Set(generations)].sort()]),
      ),
    })
  }
  // Acceptance in an ancestor is also authoritative for the selected subtree.
  let parent = session.parentID
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const ancestor = yield* services.sessions.get(parent).pipe(Effect.orDie)
    history.push(["ancestor", parent, ancestor.parentID ?? null, canonical(ancestor.directory), ancestor.projectID])
    const messages = yield* services.sessions.messages({ sessionID: parent }).pipe(Effect.orDie)
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      const directory = root(message.info.path.cwd, message.info.path.root)
      for (const part of message.parts) {
        if (part.type !== "patch") continue
        const files = part.files
          .map((file) => canonical(file, directory))
          .filter((file) => wanted.has(file))
          .sort()
        if (files.length) history.push(["ancestor-patch", parent, message.info.id, part.id, part.hash, files])
      }
    }
    const accepted = yield* services.storage.read<unknown>(["session_kept", parent]).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed({})),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))),
      Effect.orDie,
    )
    kept.push([
      parent,
      sorted(
        Object.fromEntries(
          Object.entries(accepted)
            .map(([file, boundary]) => [canonical(file, ancestor.directory), boundary])
            .filter(([file]) => wanted.has(file)),
        ),
      ),
    ])
    const ledger = yield* services.storage.read<unknown>(["session_undo", parent]).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed({ version: 1, files: {} })),
      Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
      Effect.orDie,
    )
    ledgers.push({
      sessionID: parent,
      files: Object.fromEntries(
        Object.entries(ledger.files)
          .filter(([file]) => wanted.has(canonical(file)))
          .map(([file, generations]) => [canonical(file), [...new Set(generations)].sort()]),
      ),
    })
    parent = ancestor.parentID
  }
  const diffs = yield* services.storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID]).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed([] as Snapshot.FileDiff[])),
    Effect.orDie,
  )
  const raw: Record<string, string[]> = {}
  for (const diff of diffs) {
    if (!diff.file) continue
    const file = canonical(diff.file, session.directory)
    if (!wanted.has(file)) continue
    ;(raw[file] ??= []).push(revision(diff))
  }
  for (const list of Object.values(raw)) list.sort()
  return {
    history: hash(history),
    kept: hash(kept),
    ledgers,
    raw,
    revert: session.revert ? hash(session.revert) : null,
    diffs,
    directory: session.directory,
  }
})

export const capture = Effect.fn("ReviewRecovery.capture")(function* (
  services: Services,
  sessionID: SessionID,
  files: readonly string[],
  owners: readonly Identity[],
) {
  const current = yield* inspect(services, sessionID, files)
  return {
    version: 1 as const,
    owners: [...owners],
    history: current.history,
    kept: current.kept,
    ledgers: current.ledgers,
    raw: current.raw,
    revert: current.revert,
  } satisfies Witness
})

/** Return a metadata repair only when no newer selected work can be hidden by it. */
export const repair = Effect.fn("ReviewRecovery.repair")(function* (
  services: Services,
  sessionID: SessionID,
  files: readonly string[],
  events: readonly { file: string; generation: string }[],
  witness: Witness,
) {
  const current = yield* inspect(services, sessionID, files)
  if (
    current.history !== witness.history ||
    current.kept !== witness.kept ||
    (current.revert !== null && current.revert !== witness.revert)
  )
    return undefined
  if (current.ledgers.length !== witness.ledgers.length) return undefined
  for (const ledger of current.ledgers) {
    const before = witness.ledgers.find((item) => item.sessionID === ledger.sessionID)
    if (!before) return undefined
    const allowed = { ...before.files }
    if (ledger.sessionID === sessionID)
      for (const event of events) {
        const file = canonical(event.file, current.directory)
        allowed[file] = [...new Set([...(allowed[file] ?? []), event.generation])].sort()
      }
    for (const [file, values] of Object.entries(ledger.files))
      if (values.some((generation) => !allowed[file]?.includes(generation))) return undefined
    for (const [file, values] of Object.entries(before.files))
      if (values.some((generation) => !ledger.files[file]?.includes(generation))) return undefined
  }
  for (const [file, values] of Object.entries(current.raw)) {
    const known = [...(witness.raw[file] ?? [])]
    for (const value of values) {
      const index = known.indexOf(value)
      if (index < 0) return undefined
      known.splice(index, 1)
    }
  }
  const gone = new Set(files.map((file) => canonical(file, current.directory)))
  return {
    diffs: current.diffs.filter((diff) => !diff.file || !gone.has(canonical(diff.file, current.directory))),
    clear: current.revert !== null,
  }
})
