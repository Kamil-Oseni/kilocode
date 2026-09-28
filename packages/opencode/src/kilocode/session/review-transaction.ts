import { Cause, Effect, Schema } from "effect"
import type { EventV2 } from "@opencode-ai/core/event"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { SessionSummary } from "@/session/summary"
import type { SessionRunState } from "@/session/run-state"
import type { Snapshot } from "@/snapshot"
import type { Storage } from "@/storage/storage"
import * as Project from "@/project/project"
import type { ReviewGate } from "./review-gate"
import { boundaries, canonical } from "./review-boundaries"
import { active, append, read } from "./review-undo"
import { group, identity, run, type Owner } from "./review-workspace"
import { KiloSessionRevert } from "./revert"
import { RayaRevertNote } from "./revert-note"
import { receipt, type Proof } from "./review-receipt"
import { ReviewConflict, verify, workspace } from "./review-revision"

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
  gate: ReviewGate.Interface
  events: EventV2.Interface
  project: Project.Interface
  reconcile: (sessionID: SessionID, proof: Proof) => Effect.Effect<boolean>
}
const stamp = (owners: readonly Owner[]) =>
  JSON.stringify(owners.map(identity).sort((a, b) => a.sessionID.localeCompare(b.sessionID)))

/** Route a review tree through its actual owners without replaying uncertain restores. */
export function transaction(services: Services) {
  const collect = Effect.fn("ReviewTransaction.collect")(function* (sessionID: SessionID) {
    const queue = [sessionID]
    const seen = new Set<SessionID>()
    const groups: Awaited<Effect.Success<ReturnType<typeof group>>>[] = []
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      groups.push(yield* group(services.snap, services.sessions, id))
      for (const child of yield* services.sessions.children(id)) queue.push(child.id)
    }
    return groups
  })
  const execute = Effect.fn("ReviewTransaction.execute")(function* (
    input: Input,
    action: "keep" | "undo",
    fallback: Effect.Effect<Session.Info, Session.BusyError | ReviewConflict>,
  ) {
    const prior = yield* collect(input.sessionID)
    if (new Set(prior.map((item) => canonical(item.owner.directory))).size === 1) return yield* fallback
    if (!input.expected)
      return yield* new ReviewConflict({
        message: "Refresh all workers' changes before reviewing work across workspaces.",
      })
    return yield* services.gate.withWorkspaces(prior.flatMap((item) => [item.owner.directory, item.owner.root]))(
      Effect.gen(function* () {
        const groups = yield* collect(input.sessionID)
        if (stamp(prior.map((item) => item.owner)) !== stamp(groups.map((item) => item.owner)))
          return yield* new ReviewConflict({
            message: "The workers in this review changed. Refresh before continuing.",
          })
        for (const item of groups) yield* services.state.assertNotBusy(item.owner.sessionID)
        const session = yield* services.sessions.get(input.sessionID).pipe(Effect.orDie)
        let prepared:
          | { proof: Proof; work: { owner: Owner; patches: Snapshot.Patch[]; expected: Snapshot.Patch[] }[] }
          | undefined
        const prepare = Effect.gen(function* () {
          const files = yield* verify(
            yield* services.summary.diff({ sessionID: input.sessionID }),
            input.expected!,
            session.directory,
            input.files,
          )
          const wanted = new Set(files.map((file) => canonical(file)))
          const undone = yield* read(services.storage, services.sessions, input.sessionID)
          const kept = yield* boundaries(services.storage, services.sessions, input.sessionID)
          const all = groups
            .flatMap((item) => active(item.messages, item.owner.root, undone))
            .sort((a, b) => a.info.id.localeCompare(b.info.id))
          const claims = new Map<string, Owner>()
          for (const item of groups)
            for (const message of active(item.messages, item.owner.root, undone))
              for (const part of message.parts)
                if (part.type === "patch")
                  for (const file of part.files) {
                    const key = canonical(file)
                    const previous = claims.get(key)
                    if (previous && canonical(previous.root) !== canonical(item.owner.root))
                      return yield* new ReviewConflict({
                        message:
                          "Two workers claim the same file from different workspaces. Reconcile their changes first.",
                      })
                    claims.set(key, item.owner)
                  }
          if (files.some((file) => !claims.has(canonical(file))))
            return yield* new ReviewConflict({ message: "A reviewed file no longer has a verified worker owner." })
          const plan = KiloSessionRevert.plan(all, files, kept, !!input.files?.length)
          const work: { owner: Owner; patches: Snapshot.Patch[]; expected: Snapshot.Patch[] }[] = []
          for (const item of groups) {
            const selected = files.filter((file) => claims.get(canonical(file))?.sessionID === item.owner.sessionID)
            if (!selected.length) continue
            const expected = yield* run(item.owner, workspace(services.snap, all, selected, item.owner.root))
            work.push({
              owner: item.owner,
              expected,
              patches: plan.patches.filter((patch) =>
                patch.files.some((file) => selected.some((selected) => canonical(selected) === canonical(file))),
              ),
            })
          }
          const latest: Record<string, string> = {}
          for (const message of all)
            for (const part of message.parts)
              if (part.type === "patch")
                for (const file of part.files)
                  if (wanted.has(canonical(file))) latest[canonical(file)] = message.info.id
          const proof: Proof =
            action === "keep"
              ? { version: 2, action, boundaries: latest, owners: groups.map((item) => identity(item.owner)) }
              : {
                  version: 2,
                  action,
                  groups: work.map((item) => ({ owner: identity(item.owner), patches: item.patches })),
                  files: plan.patches.flatMap((patch) => patch.files),
                  revert: !!session.revert,
                  events: plan.events,
                }
          prepared = { proof, work }
          return proof
        })
        const operation = Effect.gen(function* () {
          if (!prepared) yield* prepare
          const current = prepared!
          if (current.proof.action === "keep") {
            const previous = yield* services.storage.read<unknown>(["session_kept", input.sessionID]).pipe(
              Effect.catchTag("NotFoundError", () => Effect.succeed({})),
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))),
              Effect.orDie,
            )
            const merged = { ...previous }
            for (const [file, id] of Object.entries(current.proof.boundaries))
              if (!merged[file] || merged[file] < id) merged[file] = id
            yield* services.storage.write(["session_kept", input.sessionID], merged).pipe(Effect.orDie)
            return session
          }
          const baselines: { owner: Owner; hash: string; patches: Snapshot.Patch[] }[] = []
          for (const item of current.work) {
            if (!(yield* run(item.owner, services.snap.checkpoints(item.patches))))
              return yield* Effect.die(new Error("An Undo checkpoint is unavailable"))
            const hash = yield* run(item.owner, services.snap.track())
            if (!hash) return yield* Effect.die(new Error("A worker workspace snapshot is unavailable"))
            baselines.push({ owner: item.owner, hash, patches: item.patches })
          }
          for (const item of current.work)
            if (!(yield* run(item.owner, services.snap.matches(item.expected))))
              return yield* new ReviewConflict({
                message: "A worker's files changed before Undo. Refresh before continuing.",
              })
          const completed: typeof baselines = []
          yield* Effect.gen(function* () {
            for (const item of current.work) {
              yield* run(item.owner, services.snap.revert(item.patches, item.expected))
              completed.push(baselines.find((baseline) => baseline.owner.sessionID === item.owner.sessionID)!)
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                let combined = cause
                for (const item of completed.toReversed()) {
                  const rollback = yield* Effect.exit(
                    run(
                      item.owner,
                      services.snap.revert(
                        [{ hash: item.hash, files: item.patches.flatMap((patch) => patch.files) }],
                        item.patches,
                      ),
                    ),
                  )
                  if (rollback._tag === "Failure") combined = Cause.combine(combined, rollback.cause)
                }
                return yield* Effect.failCause(combined)
              }),
            ),
          )
          const proof = current.proof
          if (proof.action !== "undo" || !("version" in proof) || proof.version !== 2)
            return yield* Effect.die(new Error("Invalid transaction proof"))
          const gone = new Set(proof.files.map((file) => canonical(file)))
          const raw = yield* services.storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).pipe(
            Effect.catchTag("NotFoundError", () => Effect.succeed([] as Snapshot.FileDiff[])),
            Effect.orDie,
          )
          const left = raw.filter((item) => !item.file || !gone.has(canonical(item.file, session.directory)))
          yield* services.storage.write(["session_diff", input.sessionID], left).pipe(Effect.orDie)
          yield* services.events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: left })
          if (session.revert) yield* services.sessions.clearRevert(input.sessionID)
          yield* append(services.storage, input.sessionID, session.directory, proof.events ?? [])
          for (const item of current.work)
            yield* Effect.promise(() =>
              RayaRevertNote.record(
                item.owner.sessionID,
                item.patches.flatMap((patch) => patch.files),
              ),
            )
          yield* Effect.promise(() => RayaRevertNote.record(input.sessionID, proof.files))
          return yield* services.sessions.get(input.sessionID).pipe(Effect.orDie)
        })
        return yield* receipt(
          services.storage,
          input,
          action,
          prepare,
          operation,
          services.sessions.get(input.sessionID).pipe(Effect.orDie),
          (proof) => services.reconcile(input.sessionID, proof),
        )
      }),
    )
  })
  return {
    keep: (input: Input, fallback: Effect.Effect<Session.Info, Session.BusyError | ReviewConflict>) =>
      execute(input, "keep", fallback).pipe(Effect.provideService(Project.Service, services.project)),
    undo: (input: Input, fallback: Effect.Effect<Session.Info, Session.BusyError | ReviewConflict>) =>
      execute(input, "undo", fallback).pipe(Effect.provideService(Project.Service, services.project)),
  }
}
