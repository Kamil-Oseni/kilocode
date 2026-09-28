import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { SessionID } from "@/session/schema"
import type { SessionSummary } from "@/session/summary"
import type { SessionRunState } from "@/session/run-state"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { KiloSessionRevert } from "./revert"
import { RayaRevertNote } from "./revert-note"
import { boundaries, canonical } from "./review-boundaries"
import { ReviewConflict, verify, workspace } from "./review-revision"
import { project } from "./review-patches"
import { active, append, read as undone } from "./review-undo"
import { resolve, run, same } from "./review-workspace"
import { Owner, Witness, repair } from "./review-recovery"

const Events = Schema.Array(Schema.Struct({ file: Schema.String, generation: Schema.String }))
const Proof = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("keep"),
    boundaries: Schema.Record(Schema.String, Schema.String),
    version: Schema.optional(Schema.Literal(2)),
    owners: Schema.optional(Schema.Array(Owner)),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    action: Schema.Literal("undo"),
    groups: Schema.Array(Schema.Struct({ owner: Owner, patches: Schema.Array(Snapshot.Patch) })),
    files: Schema.Array(Schema.String),
    revert: Schema.Boolean,
    events: Events,
    recovery: Schema.optional(Witness),
  }),
  Schema.Struct({
    action: Schema.Literal("undo"),
    patches: Schema.Array(Snapshot.Patch),
    files: Schema.Array(Schema.String),
    revert: Schema.Boolean,
    events: Schema.optional(Events),
  }),
])
export type Proof = typeof Proof.Type
const Receipt = Schema.Struct({ digest: Schema.String, complete: Schema.Boolean, proof: Schema.optional(Proof) })
type Input = {
  sessionID: SessionID
  requestID?: string
  files?: readonly string[]
  expected?: Readonly<Record<string, string>>
}

type Services = {
  sessions: Session.Interface
  snap: Snapshot.Interface
  storage: Storage.Interface
  summary: SessionSummary.Interface
  state: SessionRunState.Interface
  gather: (sessionID: SessionID, idle?: boolean) => Effect.Effect<SessionV1.WithParts[], Session.BusyError>
  publish?: (sessionID: SessionID, diffs: Snapshot.FileDiff[]) => Effect.Effect<void>
}

/** Build durable postconditions and reconcile them without replaying a review mutation. */
export function recovery(services: Services) {
  const prepareKeep = Effect.fn("ReviewReceipt.prepareKeep")(function* (input: Input) {
    yield* services.state.assertNotBusy(input.sessionID)
    const session = yield* services.sessions.get(input.sessionID).pipe(Effect.orDie)
    const files = yield* verify(
      yield* services.summary.diff({ sessionID: input.sessionID }),
      input.expected ?? {},
      session.directory,
      input.files,
    )
    const all = active(
      yield* project(services.snap, yield* services.gather(input.sessionID, true), session.directory),
      session.directory,
      yield* undone(services.storage, services.sessions, input.sessionID),
    )
    yield* workspace(services.snap, all, files, session.directory)
    const wanted = new Set(files.map((file) => canonical(file, session.directory)))
    const latest: Record<string, string> = {}
    for (const msg of all)
      for (const part of msg.parts)
        if (part.type === "patch")
          for (const file of part.files) {
            const key = canonical(file, session.directory)
            if (!wanted.has(key)) continue
            latest[key] = msg.info.id
          }
    return { action: "keep" as const, boundaries: latest }
  })

  const prepareUndo = Effect.fn("ReviewReceipt.prepareUndo")(function* (input: Input) {
    yield* services.state.assertNotBusy(input.sessionID)
    const session = yield* services.sessions.get(input.sessionID).pipe(Effect.orDie)
    const files = yield* verify(
      yield* services.summary.diff({ sessionID: input.sessionID }),
      input.expected ?? {},
      session.directory,
      input.files,
    )
    const all = active(
      yield* project(services.snap, yield* services.gather(input.sessionID, true), session.directory),
      session.directory,
      yield* undone(services.storage, services.sessions, input.sessionID),
    )
    yield* workspace(services.snap, all, files, session.directory)
    const kept = yield* boundaries(services.storage, services.sessions, input.sessionID)
    const plan = KiloSessionRevert.plan(all, files, kept, !!input.files?.length)
    return {
      action: "undo" as const,
      patches: plan.patches,
      files: [...new Set(plan.patches.flatMap((patch) => patch.files))],
      revert: !!session.revert,
      events: plan.events,
    }
  })

  const reconcile = Effect.fn("ReviewReceipt.reconcile")(function* (sessionID: SessionID, proof: Proof) {
    const owners =
      proof.action === "keep"
        ? proof.owners
        : "groups" in proof
          ? (proof.recovery?.owners ?? proof.groups.map((group) => group.owner))
          : undefined
    for (const saved of owners ?? []) {
      const owner = yield* resolve(services.sessions, saved.sessionID).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (!owner || !same(saved, owner)) return false
      const idle = yield* run(owner, services.state.assertNotBusy(saved.sessionID)).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      )
      if (!idle) return false
    }
    if (proof.action === "keep") {
      const kept = yield* boundaries(services.storage, services.sessions, sessionID)
      return Object.entries(proof.boundaries).every(([file, id]) => {
        const boundary = kept[file]
        return boundary !== undefined && boundary >= id
      })
    }
    const session = yield* services.sessions.get(sessionID).pipe(Effect.orDie)
    if (proof.revert && session.revert && !("groups" in proof && proof.recovery)) return false
    if ("groups" in proof) {
      for (const group of proof.groups) {
        const owner = yield* resolve(services.sessions, group.owner.sessionID).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (!owner || !same(group.owner, owner)) return false
        if (
          !(yield* run(owner, services.snap.matches(group.patches)).pipe(
            Effect.catchCause(() => Effect.succeed(false)),
          ))
        )
          return false
      }
    } else if (proof.patches.length && !(yield* services.snap.matches(proof.patches))) return false
    if ("groups" in proof && proof.recovery) {
      const fixed = yield* repair(services, sessionID, proof.files, proof.events, proof.recovery)
      if (!fixed) return false
      // Recheck exact physical owners and targets at the metadata commit boundary.
      for (const group of proof.groups) {
        const owner = yield* resolve(services.sessions, group.owner.sessionID).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (
          !owner ||
          !same(group.owner, owner) ||
          !(yield* run(owner, services.snap.matches(group.patches)).pipe(
            Effect.catchCause(() => Effect.succeed(false)),
          ))
        )
          return false
      }
      const checked = yield* repair(services, sessionID, proof.files, proof.events, proof.recovery)
      if (!checked) return false
      yield* append(services.storage, sessionID, session.directory, proof.events)
      yield* services.storage.write(["session_diff", sessionID], checked.diffs).pipe(Effect.orDie)
      if (checked.clear) yield* services.sessions.clearRevert(sessionID)
      if (services.publish) yield* services.publish(sessionID, checked.diffs)
      yield* Effect.promise(() => RayaRevertNote.record(sessionID, proof.files))
      for (const group of proof.groups)
        if (group.owner.sessionID !== sessionID)
          yield* Effect.promise(() =>
            RayaRevertNote.record(
              group.owner.sessionID,
              group.patches.flatMap((patch) => patch.files),
            ),
          )
      return true
    }
    const normalize = (file: string) => canonical(file, session.directory)
    const gone = new Set(proof.files.map(normalize))
    const raw = yield* services.storage.read<Snapshot.FileDiff[]>(["session_diff", sessionID]).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed([] as Snapshot.FileDiff[])),
      Effect.orDie,
    )
    if (raw.some((diff) => !!diff.file && gone.has(normalize(diff.file)))) return false
    if (proof.events?.length) yield* append(services.storage, sessionID, session.directory, proof.events)
    yield* Effect.promise(() => RayaRevertNote.record(sessionID, proof.files))
    if ("groups" in proof)
      for (const group of proof.groups)
        if (group.owner.sessionID !== sessionID)
          yield* Effect.promise(() =>
            RayaRevertNote.record(
              group.owner.sessionID,
              group.patches.flatMap((patch) => patch.files),
            ),
          )
    return true
  })

  return {
    prepare: (input: Input, action: "keep" | "undo") => (action === "keep" ? prepareKeep(input) : prepareUndo(input)),
    reconcile,
  }
}

/** Run inside the checkpoint semaphore; pending receipts never authorize replaying a mutation. */
export const receipt = Effect.fn("ReviewReceipt.run")(function* (
  storage: Storage.Interface,
  input: Input,
  action: "keep" | "undo",
  prepare: Effect.Effect<Proof, Session.BusyError | ReviewConflict>,
  operation: Effect.Effect<Session.Info, Session.BusyError | ReviewConflict>,
  replay: Effect.Effect<Session.Info>,
  reconcile: (proof: Proof) => Effect.Effect<boolean>,
) {
  if (input.requestID === undefined) return yield* operation
  if (!input.requestID || input.requestID.length > 128 || !input.expected)
    return yield* new ReviewConflict({ message: "A review retry requires a request ID and expected file revisions." })
  // Validate session lifetime before creating metadata; deletion shares the caller's gate.
  const session = yield* replay
  const key = ["review_receipt", input.sessionID, createHash("sha256").update(input.requestID).digest("hex")]
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        action,
        input.files ? [...input.files].sort() : null,
        Object.entries(input.expected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest("hex")
  const previous = yield* storage.read<unknown>(key).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
    Effect.flatMap((value) =>
      value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(Receipt)(value),
    ),
    Effect.orDie,
  )
  if (previous) {
    if (previous.digest !== digest)
      return yield* new ReviewConflict({
        message: "This review request ID was already used for a different action or revision.",
      })
    if (!previous.complete) {
      if (!previous.proof || previous.proof.action !== action || !(yield* reconcile(previous.proof)))
        return yield* new ReviewConflict({
          message:
            "The previous review outcome is uncertain. Inspect the current files before starting another review action.",
        })
      yield* storage.replace(key, { ...previous, complete: true }).pipe(Effect.orDie)
      return session
    }
    return session
  }
  const proof = yield* prepare
  const claimed = yield* storage.create(key, { digest, complete: false, proof }).pipe(Effect.orDie)
  if (!claimed)
    return yield* new ReviewConflict({
      message: "Another backend claimed this review request. Retry with the same request ID to check its outcome.",
    })
  const result = yield* operation.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // Busy and revision conflicts are pre-mutation failures; a corrected retry is safe.
        // Unexpected defects retain the pending receipt, including failed persistence after a restore.
        yield* storage.remove(key).pipe(Effect.orDie)
        return yield* Effect.fail(error)
      }),
    ),
  )
  yield* storage.replace(key, { digest, complete: true, proof }).pipe(Effect.orDie)
  return result
})
