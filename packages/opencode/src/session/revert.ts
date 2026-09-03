import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config" // kilocode_change
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { KiloSessionRevert } from "@/kilocode/session/revert" // kilocode_change
import { RayaRevertNote } from "@/kilocode/session/revert-note" // kilocode_change

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  // kilocode_change start - files-only discard: undo session file edits (all, or a
  // specific subset for per-edit Undo), keep the conversation
  readonly discardChanges: (input: {
    sessionID: SessionID
    files?: readonly string[]
  }) => Effect.Effect<Session.Info, Session.BusyError>
  // raya_change - Keep / Keep all: record a "kept boundary" so a later Undo only
  // rewinds edits made after this point, never the work the user just accepted.
  readonly keepChanges: (input: {
    sessionID: SessionID
    files?: readonly string[]
  }) => Effect.Effect<Session.Info, Session.BusyError>
  // kilocode_change end
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const config = yield* Config.Service // kilocode_change

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: SessionV1.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      // kilocode_change start
      // A fresh snapshot only preserves the state needed for redo. File restoration
      // is possible only when the historical turn retained checkpoint data.
      const range = all.filter((msg) => msg.info.id >= rev.messageID)
      const checkpoint = patches.length > 0
      rev.workspace = checkpoint
        ? "restored"
        : (yield* config.get()).snapshot === false
          ? "snapshots-disabled"
          : "unavailable"
      // kilocode_change end
      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      // kilocode_change start - keep the entire workspace transition atomic
      const prior = session.revert ? KiloSessionRevert.files(all, session.revert) : []
      const files = [...new Set([...prior, ...patches.flatMap((patch) => patch.files)])]
      const baseline = session.revert?.snapshot && files.length > 0 ? yield* snap.track() : rev.snapshot
      if (files.length > 0 && !baseline) {
        return yield* Effect.die(new Error("Cannot rewind files because the current workspace snapshot is unavailable"))
      }
      yield* KiloSessionRevert.apply(
        snap,
        baseline,
        files,
        Effect.gen(function* () {
          if (session.revert?.snapshot) yield* KiloSessionRevert.restore(snap, session.revert.snapshot, prior)

          // Compute the user-facing diff while files still contain the changes being undone.
          const diffs = yield* summary.computeDiff({ messages: range })
          yield* snap.revert(patches)
          if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
          yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
          yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
          const summaryDiffs: Snapshot.SummaryFileDiff[] = diffs.map((d) => ({
            file: d.file,
            additions: d.additions,
            deletions: d.deletions,
            status: d.status,
          }))
          yield* sessions.setRevert({
            sessionID: input.sessionID,
            revert: rev,
            summary: {
              additions: diffs.reduce((sum, x) => sum + x.additions, 0),
              deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
              files: diffs.length,
              diffs: summaryDiffs,
            },
          })
        }),
      )
      // kilocode_change end
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      // kilocode_change start - preserve the reverted workspace if redo cannot complete
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const files = KiloSessionRevert.files(all, session.revert)
      const baseline = files.length > 0 ? yield* snap.track() : undefined
      if (files.length > 0 && !baseline) {
        return yield* Effect.die(
          new Error("Cannot restore files because the current workspace snapshot is unavailable"),
        )
      }
      yield* KiloSessionRevert.apply(
        snap,
        baseline,
        files,
        Effect.gen(function* () {
          if (session.revert?.snapshot) yield* KiloSessionRevert.restore(snap, session.revert.snapshot, files)
          yield* sessions.clearRevert(input.sessionID)
        }),
      )
      // kilocode_change end
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    // kilocode_change start - gather a session's parent plus every descendant
    // subagent session, sorted by (globally monotonic) message id. A delegated
    // turn (agent=auto → @coder/@designer/@generalist) makes its file edits inside
    // child sessions, which is where the "patch" parts land, so files-only
    // discard/keep must see them to match the workspace-wide review diff.
    const gather = Effect.fn("SessionRevert.gather")(function* (sessionID: SessionID) {
      const all: SessionV1.WithParts[] = []
      const queue: SessionID[] = [sessionID]
      while (queue.length > 0) {
        const id = queue.shift()
        if (!id) break
        const msgs = yield* sessions.messages({ sessionID: id }).pipe(Effect.orDie)
        for (const msg of msgs) all.push(msg)
        const kids = yield* sessions.children(id)
        for (const kid of kids) queue.push(kid.id)
      }
      all.sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
      return all
    })

    const matchesFile = (file: string, want: Set<string>) => {
      if (want.has(file)) return true
      for (const w of want) if (file === w || file.endsWith(`/${w}`)) return true
      return false
    }

    // raya_change - Keep / Keep all records the "kept boundary": the message id of
    // each file's most recent edit at the moment it is accepted. A later Undo only
    // considers edits after this id, so accepting work then undoing a fresh edit
    // steps back to the kept content instead of wiping everything since the session
    // began (the reported "Keep all then Undo all deletes the date too" bug).
    const keepChanges = Effect.fn("SessionRevert.keepChanges")(function* (input: {
      sessionID: SessionID
      files?: readonly string[]
    }) {
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const all = yield* gather(input.sessionID)
      const want = input.files ? new Set(input.files.map((file) => file.replaceAll("\\", "/"))) : undefined
      const latest: Record<string, string> = {}
      for (const msg of all)
        for (const part of msg.parts)
          if (part.type === "patch")
            for (const file of part.files) {
              const norm = file.replaceAll("\\", "/")
              if (want && !matchesFile(norm, want)) continue
              latest[norm] = msg.info.id // ascending order, so this settles on the max
            }
      if (Object.keys(latest).length === 0) return session
      const prev = yield* storage
        .read<Record<string, string>>(["session_kept", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed({} as Record<string, string>)))
      const merged = { ...prev }
      for (const [file, id] of Object.entries(latest)) merged[file] = !merged[file] || id > merged[file]! ? id : merged[file]!
      yield* storage.write(["session_kept", input.sessionID], merged).pipe(Effect.ignore)
      return session
    })

    // discard session file edits (all, or a subset for per-edit Undo) without
    // removing messages or arming a revert boundary. Honors the kept boundary so an
    // Undo never rewinds past accepted work.
    const discardChanges = Effect.fn("SessionRevert.discardChanges")(function* (input: {
      sessionID: SessionID
      files?: readonly string[]
    }) {
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const all = yield* gather(input.sessionID)
      const kept = yield* storage
        .read<Record<string, string>>(["session_kept", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed({} as Record<string, string>)))
      const result = yield* KiloSessionRevert.discardAll(snap, all, input.files ? [...input.files] : undefined, kept)
      if (result.files.length === 0) return session
      // kilocode_change - surface the undo to the model on its next turn so it re-reads
      // instead of trusting the now-stale edits still shown in the conversation history.
      RayaRevertNote.record(input.sessionID, result.files)
      // Discarding everything clears the review UI outright; a per-file undo leaves
      // other edits intact, so let the client re-poll the remaining diff instead.
      if (!input.files || input.files.length === 0) {
        yield* storage.write(["session_diff", input.sessionID], []).pipe(Effect.ignore)
        yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: [] })
      } else {
        // Per-file undo must drop that file from the stored review diff so chat
        // Keep all / Undo all and in-editor lenses stay in sync with the workspace.
        const raw = yield* storage
          .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
          .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
        const gone = new Set(result.files.map((file) => file.replaceAll("\\", "/")))
        const left = raw.filter((item) => !gone.has((item.file ?? "").replaceAll("\\", "/")))
        yield* storage.write(["session_diff", input.sessionID], left).pipe(Effect.ignore)
        yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: left })
      }
      // A prior partial revert boundary would otherwise keep a redo affordance alive.
      if (session.revert) yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })
    // kilocode_change end

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const remove = [] as SessionV1.WithParts[]
      let target: SessionV1.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
          // kilocode_change start - clear a reverted provider error from the retained assistant message
          if (target.info.role === "assistant" && target.info.error) {
            delete target.info.error
            yield* sessions.updateMessage(target.info)
          }
          // kilocode_change end
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, discardChanges, keepChanges, cleanup }) // kilocode_change - discard/keep boundary
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Snapshot.node,
    Storage.node,
    EventV2Bridge.node,
    SessionSummary.node,
    SessionRunState.node,
    Config.node, // kilocode_change
  ],
})

export * as SessionRevert from "./revert"
