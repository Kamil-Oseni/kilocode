import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Global } from "@opencode-ai/core/global"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageV2 } from "@/session/message-v2"
import { KiloSessionRevert } from "@/kilocode/session/revert"
import { RayaRevertNote } from "@/kilocode/session/revert-note"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { revision } from "@/kilocode/session/review-revision"
import { ReviewGate } from "@/kilocode/session/review-gate"
import { BackgroundJob } from "@/background/job"
import { provideInstance, provideTmpdirInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const env = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    SessionRevert.node,
    SessionSummary.node,
    Snapshot.node,
    CrossSpawnSpawner.node,
    Storage.node,
    ReviewGate.node,
    BackgroundJob.node,
  ]),
)
const it = testEffect(env)
const guarded = process.platform === "win32" ? it.live.skip : it.live

const setup = Effect.fnUntraced(function* (dir: string, deleted = false) {
  const sessions = yield* Session.Service
  const revert = yield* SessionRevert.Service
  const snapshot = yield* Snapshot.Service
  const session = yield* sessions.create({})
  const locked = path.join(dir, "locked")
  const protectedFile = path.join(locked, "protected.txt")
  const writableFile = path.join(dir, "writable.txt")
  const providerID = ProviderV2.ID.make("test")
  yield* Effect.promise(() => fs.mkdir(locked))
  yield* Effect.promise(() => fs.writeFile(protectedFile, "before"))
  yield* Effect.promise(() => fs.writeFile(writableFile, "before"))
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "default",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: session.id,
    type: "text",
    text: "change both files",
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("test"),
    providerID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
  const before = yield* snapshot.track()
  if (!before) throw new Error("expected snapshot")
  if (deleted) yield* Effect.promise(() => fs.rm(protectedFile))
  if (!deleted) yield* Effect.promise(() => fs.writeFile(protectedFile, "after"))
  yield* Effect.promise(() => fs.writeFile(writableFile, "after"))
  const after = yield* snapshot.track()
  if (!after) throw new Error("expected snapshot")
  const patch = yield* snapshot.patch(before)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: session.id,
    type: "step-start",
    snapshot: before,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: session.id,
    type: "step-finish",
    reason: "stop",
    snapshot: after,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: session.id,
    type: "patch",
    hash: patch.hash,
    files: patch.files,
  })
  return {
    sessions,
    revert,
    snapshot,
    session,
    user,
    after,
    patch,
    locked,
    protected: protectedFile,
    writable: writableFile,
  }
})

describe("kept boundary integrity", () => {
  for (const action of ["keepChanges", "discardChanges"] as const) {
    it.live(
      `${action} cannot create a receipt for a deleted session`,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const state = yield* setup(dir)
            const storage = yield* Storage.Service
            yield* state.sessions.remove(state.session.id)
            expect(
              Exit.isFailure(
                yield* Effect.exit(
                  state.revert[action]({ sessionID: state.session.id, requestID: "after-deletion", expected: {} }),
                ),
              ),
            ).toBe(true)
            expect(yield* storage.list(["review_receipt", state.session.id])).toEqual([])
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
          }),
        { git: true },
      ),
      30_000,
    )
  }

  it.live(
    "deletion cancels background work before taking its cleanup gate",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const gate = yield* ReviewGate.Service
          const background = yield* BackgroundJob.Service
          const entered = yield* Deferred.make<void>()
          let cleaned = false
          yield* background.start({
            id: state.session.id,
            type: "task",
            metadata: { sessionId: state.session.id },
            run: Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Effect.never
              return "complete"
            }).pipe(
              Effect.ensuring(
                gate.withPermits(1)(
                  Effect.sync(() => {
                    cleaned = true
                  }),
                ),
              ),
            ),
          })
          yield* Deferred.await(entered)
          yield* state.sessions.remove(state.session.id)
          expect(cleaned).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(state.sessions.get(state.session.id)))).toBe(true)
        }),
      { git: true },
    ),
    30_000,
  )

  for (const action of ["remove", "keepChanges", "discardChanges"] as const) {
    it.live(
      `${action} waits for the shared review lifecycle gate`,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const state = yield* setup(dir)
            const gate = yield* ReviewGate.Service
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const holder = yield* gate
              .withPermits(1)(
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }),
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            const child = yield* state.sessions.create({ parentID: state.session.id })
            yield* state.sessions.updateMessage({ ...state.user, id: MessageID.ascending(), sessionID: child.id })
            let done = false
            const operation =
              action === "remove"
                ? state.sessions.remove(state.session.id).pipe(Effect.orDie)
                : state.revert[action]({ sessionID: state.session.id, expected: {} }).pipe(Effect.asVoid, Effect.orDie)
            const pending = yield* operation.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  done = true
                }),
              ),
              Effect.forkChild,
            )
            yield* Effect.yieldNow
            expect(done).toBe(false)
            expect((yield* state.sessions.get(state.session.id)).id).toBe(state.session.id)
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(holder)
            yield* Fiber.join(pending)
            expect(done).toBe(true)
            if (action === "remove") {
              expect(Exit.isFailure(yield* Effect.exit(state.sessions.get(state.session.id)))).toBe(true)
              expect(Exit.isFailure(yield* Effect.exit(state.sessions.get(child.id)))).toBe(true)
            }
          }),
        { git: true },
      ),
      30_000,
    )
  }

  it.live(
    "identical content from a later agent edit has a new review identity",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const storage = yield* Storage.Service
          const summary = yield* SessionSummary.Service
          const diffs = yield* state.snapshot.diffFull(state.patch.hash, state.after)
          yield* storage.write(["session_diff", state.session.id], diffs)
          const before = yield* summary.diff({ sessionID: state.session.id })
          const expected = Object.fromEntries(before.map((diff) => [diff.file!, revision(diff)]))
          yield* state.revert.keepChanges({ sessionID: state.session.id, expected, requestID: "first-generation" })
          const messages = yield* state.sessions.messages({ sessionID: state.session.id })
          const previous = messages.find((message) => message.info.role === "assistant")!
          const next = MessageID.ascending()
          yield* state.sessions.updateMessage({ ...previous.info, id: next })
          for (const part of previous.parts) {
            yield* state.sessions.updatePart({ ...part, id: PartID.ascending(), messageID: next })
          }
          const after = yield* summary.diff({ sessionID: state.session.id })
          expect(after.map((diff) => diff.patch)).toEqual(before.map((diff) => diff.patch))
          expect(after.map(revision)).not.toEqual(before.map(revision))
          expect(after.every((diff) => diff.reviewed === "")).toBe(true)
          expect((yield* Effect.flip(state.revert.keepChanges({ sessionID: state.session.id, expected })))._tag).toBe(
            "ReviewConflict",
          )
          const current = Object.fromEntries(after.map((diff) => [diff.file!, revision(diff)]))
          yield* state.revert.keepChanges({
            sessionID: state.session.id,
            expected: current,
            requestID: "second-generation",
          })
          expect(
            (yield* summary.diff({ sessionID: state.session.id })).every((diff) => diff.reviewed === revision(diff)),
          ).toBe(true)
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "a pre-mutation revision rejection does not poison a corrected retry",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const storage = yield* Storage.Service
          const diffs = yield* state.snapshot.diffFull(state.patch.hash, state.after)
          yield* storage.write(["session_diff", state.session.id], diffs)
          const expected = Object.fromEntries(
            (yield* (yield* SessionSummary.Service).diff({ sessionID: state.session.id }))
              .filter((diff) => diff.file)
              .map((diff) => [diff.file!, revision(diff)]),
          )
          const input = { sessionID: state.session.id, requestID: "corrected-a" }
          expect(
            (yield* Effect.flip(state.revert.keepChanges({ ...input, expected: { missing: "stale" } })))._tag,
          ).toBe("ReviewConflict")
          expect((yield* state.revert.keepChanges({ ...input, expected })).id).toBe(state.session.id)
        }),
      { git: true },
    ),
    30_000,
  )

  for (const action of ["keepChanges", "discardChanges"] as const) {
    it.live(
      `${action} replays a completed request without touching newer manual work`,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const state = yield* setup(dir)
            const storage = yield* Storage.Service
            const diffs = yield* state.snapshot.diffFull(state.patch.hash, state.after)
            yield* storage.write(["session_diff", state.session.id], diffs)
            const expected = Object.fromEntries(
              (yield* (yield* SessionSummary.Service).diff({ sessionID: state.session.id }))
                .filter((diff) => diff.file)
                .map((diff) => [diff.file!, revision(diff)]),
            )
            const input = { sessionID: state.session.id, expected, requestID: "retry-a" }
            const results = yield* Effect.all([state.revert[action](input), state.revert[action](input)], {
              concurrency: 2,
            })
            expect(results.map((result) => result.id)).toEqual([state.session.id, state.session.id])
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe(
              action === "keepChanges" ? "after" : "before",
            )
            yield* Effect.promise(() => fs.writeFile(state.writable, "manual work after completion"))
            expect((yield* state.revert[action](input)).id).toBe(state.session.id)
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe(
              "manual work after completion",
            )
            const opposite = action === "keepChanges" ? "discardChanges" : "keepChanges"
            expect((yield* Effect.flip(state.revert[opposite](input)))._tag).toBe("ReviewConflict")
          }),
        { git: true },
      ),
      30_000,
    )
  }

  it.live(
    "an incomplete review receipt blocks replay after an unexpected storage failure",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const storage = yield* Storage.Service
          const diffs = yield* state.snapshot.diffFull(state.patch.hash, state.after)
          yield* storage.write(["session_diff", state.session.id], diffs)
          const expected = Object.fromEntries(
            (yield* (yield* SessionSummary.Service).diff({ sessionID: state.session.id }))
              .filter((diff) => diff.file)
              .map((diff) => [diff.file!, revision(diff)]),
          )
          const input = { sessionID: state.session.id, expected, requestID: "interrupted-a" }
          yield* storage.write(["session_kept", state.session.id], { invalid: 123 })
          expect(Exit.isFailure(yield* Effect.exit(state.revert.discardChanges(input)))).toBe(true)
          yield* storage.write(["session_kept", state.session.id], {})
          const error = yield* Effect.flip(state.revert.discardChanges(input))
          expect(error._tag).toBe("ReviewConflict")
          expect("message" in error && error.message).toContain("outcome is uncertain")
          expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
        }),
      { git: true },
    ),
    30_000,
  )

  for (const direction of ["child", "parent"] as const) {
    it.live(
      `a ${direction} Keep is visible across the session hierarchy and fences Undo`,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const state = yield* setup(dir)
            const storage = yield* Storage.Service
            const summary = yield* SessionSummary.Service
            const messages = yield* state.sessions.messages({ sessionID: state.session.id })
            const previous = messages.find((message) => message.info.role === "assistant")!
            const user = messages.find((message) => message.info.role === "user")!
            const child = yield* state.sessions.create({ parentID: state.session.id })
            const prompt = MessageID.ascending()
            yield* state.sessions.updateMessage({ ...user.info, id: prompt, sessionID: child.id })
            const id = MessageID.ascending()
            if (previous.info.role !== "assistant") throw new Error("Expected assistant")
            yield* state.sessions.updateMessage({ ...previous.info, id, sessionID: child.id, parentID: prompt })
            yield* state.sessions.updatePart({
              id: PartID.ascending(),
              sessionID: child.id,
              messageID: id,
              type: "patch",
              hash: state.patch.hash,
              files: [state.writable],
            })
            const diffs = (yield* state.snapshot.diffFull(state.patch.hash, state.after)).filter(
              (diff) => diff.file === "writable.txt",
            )
            yield* storage.write(["session_diff", state.session.id], [])
            yield* storage.write(["session_diff", child.id], diffs)
            const owner = direction === "child" ? child.id : state.session.id
            const target = direction === "child" ? state.session.id : child.id
            yield* state.revert.keepChanges({ sessionID: owner, files: [state.writable] })
            const projected = yield* summary.diff({ sessionID: target })
            expect(projected[0]?.reviewed).toBe(revision(projected[0]))
            const kept = yield* storage.read<Record<string, string>>(["session_kept", owner])
            yield* storage.write(["session_kept", owner], { invalid: 123 })
            expect(Exit.isFailure(yield* Effect.exit(state.revert.discardChanges({ sessionID: target })))).toBe(true)
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
            yield* storage.write(["session_kept", owner], kept)
            yield* state.revert.discardChanges({ sessionID: target })
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
            yield* Effect.promise(() => fs.writeFile(state.writable, "later parent edit"))
            const later = MessageID.ascending()
            yield* state.sessions.updateMessage({
              ...previous.info,
              id: later,
              sessionID: target,
              parentID: target === child.id ? prompt : previous.info.parentID,
            })
            yield* state.sessions.updatePart({
              id: PartID.ascending(),
              sessionID: target,
              messageID: later,
              type: "patch",
              hash: state.after,
              files: [state.writable],
            })
            expect((yield* summary.diff({ sessionID: target }))[0]?.reviewed).toBe("")
            yield* state.revert.discardChanges({ sessionID: target, files: [state.writable] })
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
          }),
        { git: true },
      ),
      30_000,
    )
  }

  it.live(
    "review acceptance is reconstructed from persisted boundaries and revoked by later edits",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const summary = yield* SessionSummary.Service
          const storage = yield* Storage.Service
          const diffs = yield* state.snapshot.diffFull(state.patch.hash, state.after)
          yield* storage.write(["session_diff", state.session.id], diffs)
          expect((yield* summary.diff({ sessionID: state.session.id })).every((diff) => !diff.reviewed)).toBe(true)
          yield* state.revert.keepChanges({ sessionID: state.session.id, files: [state.writable] })
          const restored = yield* summary.diff({ sessionID: state.session.id })
          const accepted = restored.find((diff) => diff.file === "writable.txt")
          expect(accepted?.reviewed).toBe(revision(accepted!))
          expect(restored.find((diff) => diff.file?.includes("protected"))?.reviewed).toBe("")
          const messages = yield* state.sessions.messages({ sessionID: state.session.id })
          const previous = messages.find((message) => message.info.role === "assistant")!
          const id = MessageID.ascending()
          yield* state.sessions.updateMessage({ ...previous.info, id })
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: id,
            sessionID: state.session.id,
            type: "patch",
            hash: state.after,
            files: [state.writable],
          })
          expect(
            (yield* summary.diff({ sessionID: state.session.id })).find((diff) => diff.file === "writable.txt")
              ?.reviewed,
          ).toBe("")
          yield* storage.write(["session_kept", state.session.id], { invalid: 123 })
          expect(Exit.isFailure(yield* Effect.exit(summary.diff({ sessionID: state.session.id })))).toBe(true)
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "workspace verification rejects a redirected parent directory even with identical content",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const expected = [{ hash: state.after, files: [state.protected] }]
          expect(yield* state.snapshot.matches(expected)).toBe(true)
          const moved = path.join(dir, "relocated")
          yield* Effect.promise(() => fs.rename(state.locked, moved))
          yield* Effect.promise(() =>
            fs.symlink(moved, state.locked, process.platform === "win32" ? "junction" : "dir"),
          )
          expect(yield* Effect.promise(() => fs.readFile(state.protected, "utf8"))).toBe("after")
          expect(yield* state.snapshot.matches(expected)).toBe(false)
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "a late workspace conflict does not roll back newer manual edits",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const expected = [{ hash: state.after, files: [state.writable] }]
          expect(yield* state.snapshot.matches(expected)).toBe(true)
          const baseline = yield* state.snapshot.track()
          yield* Effect.promise(() => fs.writeFile(state.writable, "late manual edit"))
          const result = yield* Effect.exit(
            KiloSessionRevert.apply(
              state.snapshot,
              baseline,
              [state.writable],
              state.snapshot.revert([{ hash: state.patch.hash, files: [state.writable] }], expected),
            ),
          )
          expect(Exit.isFailure(result)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("late manual edit")
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "workspace verification detects recreation of a deleted file and missing snapshots",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir, true)
          const expected = [{ hash: state.after, files: [state.protected] }]
          expect(yield* state.snapshot.matches(expected)).toBe(true)
          yield* Effect.promise(() => fs.writeFile(state.protected, "recreated manually"))
          expect(yield* state.snapshot.matches(expected)).toBe(false)
          expect(yield* state.snapshot.matches([{ hash: "0".repeat(40), files: [state.writable] }])).toBe(false)
          expect(yield* state.snapshot.matches([{ hash: state.after, files: [path.join(dir, "..", "outside")] }])).toBe(
            false,
          )
        }),
      { git: true },
    ),
    30_000,
  )

  for (const action of ["keepChanges", "discardChanges"] as const) {
    it.live(
      `${action} protects newer workspace content outside the recorded diff`,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const state = yield* setup(dir)
            const storage = yield* Storage.Service
            const diffs = yield* state.snapshot.diffFull(state.patch.hash, state.after)
            yield* storage.write(["session_diff", state.session.id], diffs)
            const expected = Object.fromEntries(
              (yield* (yield* SessionSummary.Service).diff({ sessionID: state.session.id }))
                .filter((diff) => diff.file)
                .map((diff) => [diff.file!, revision(diff)]),
            )
            yield* Effect.promise(() => fs.writeFile(state.writable, "newer manual work"))
            const result = yield* Effect.exit(state.revert[action]({ sessionID: state.session.id, expected }))
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("newer manual work")
            expect(Exit.isFailure(result)).toBe(true)
            expect((yield* Effect.flip(storage.read(["session_kept", state.session.id])))._tag).toBe("NotFoundError")
          }),
        { git: true },
      ),
      30_000,
    )
  }

  it.live(
    "revision-guarded Undo all restores the original boundary across multiple edits",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const storage = yield* Storage.Service
          const messages = yield* state.sessions.messages({ sessionID: state.session.id })
          const assistant = messages.find((message) => message.info.role === "assistant")
          if (!assistant) throw new Error("Expected an assistant edit")
          yield* Effect.promise(() => fs.writeFile(state.writable, "third"))
          const after = yield* state.snapshot.track()
          if (!after) throw new Error("Expected current snapshot")
          const patch = yield* state.snapshot.patch(state.after)
          const finish = assistant.parts.find((part) => part.type === "step-finish")
          if (!finish) throw new Error("Expected completed edit")
          yield* state.sessions.updatePart({ ...finish, id: PartID.ascending(), snapshot: after })
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.info.id,
            sessionID: state.session.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })
          const diffs = yield* state.snapshot.diffFull(state.patch.hash, after)
          yield* storage.write(["session_diff", state.session.id], diffs)
          const expected = Object.fromEntries(
            (yield* (yield* SessionSummary.Service).diff({ sessionID: state.session.id }))
              .filter((diff) => diff.file)
              .map((diff) => [diff.file!, revision(diff)]),
          )
          yield* state.revert.discardChanges({ sessionID: state.session.id, expected })
          expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("before")
        }),
      { git: true },
    ),
    30_000,
  )

  for (const action of ["keepChanges", "discardChanges"] as const) {
    it.live(
      `${action} rejects superseded review content before mutating files or acceptance`,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const state = yield* setup(dir)
            const storage = yield* Storage.Service
            const diffs = yield* state.snapshot.diffFull(state.patch.hash, state.after)
            expect(diffs.length).toBeGreaterThan(0)
            yield* storage.write(["session_diff", state.session.id], diffs)
            const expected = Object.fromEntries(
              (yield* (yield* SessionSummary.Service).diff({ sessionID: state.session.id }))
                .filter((diff) => diff.file)
                .map((diff) => [diff.file!, revision(diff)]),
            )
            const changed = diffs.map((diff, index) =>
              index === 0 ? { ...diff, patch: `${diff.patch}\n+later edit` } : diff,
            )
            yield* storage.write(["session_diff", state.session.id], changed)
            const error = yield* Effect.flip(state.revert[action]({ sessionID: state.session.id, expected }))
            expect(error._tag).toBe("ReviewConflict")
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
            expect((yield* Effect.flip(storage.read(["session_kept", state.session.id])))._tag).toBe("NotFoundError")
            yield* storage.write(["session_diff", state.session.id], diffs)
            yield* state.revert[action]({ sessionID: state.session.id, expected })
            expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe(
              action === "keepChanges" ? "after" : "before",
            )
          }),
        { git: true },
      ),
      30_000,
    )
  }

  it.live(
    "concurrent per-file keeps preserve both accepted boundaries",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const storage = yield* Storage.Service
          yield* Effect.all(
            [state.protected, state.writable].map((file) =>
              state.revert.keepChanges({ sessionID: state.session.id, files: [file] }),
            ),
            { concurrency: "unbounded" },
          )
          const kept = yield* storage.read<Record<string, string>>(["session_kept", state.session.id])
          expect(Object.keys(kept).sort()).toEqual(
            [state.protected, state.writable].map((file) => file.replaceAll("\\", "/")).sort(),
          )
          yield* state.revert.discardChanges({ sessionID: state.session.id })
          expect(yield* Effect.promise(() => fs.readFile(state.protected, "utf8"))).toBe("after")
          expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
        }),
      { git: true },
    ),
    30_000,
  )

  for (const action of ["keepChanges", "discardChanges"] as const) {
    it.live(
      `${action} fails safely on unreadable or malformed accepted boundaries`,
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const state = yield* setup(dir)
            const target = path.join(Global.Path.data, "storage", "session_kept", `${state.session.id}.json`)
            yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
            for (const content of ["{broken", JSON.stringify({ [state.writable]: 42 })]) {
              yield* Effect.promise(() => fs.writeFile(target, content))
              const result = yield* Effect.exit(state.revert[action]({ sessionID: state.session.id }))
              expect(Exit.isFailure(result)).toBe(true)
              expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(content)
            }
          }),
        { git: true },
      ),
      30_000,
    )
  }
})

describe("partial assistant revert", () => {
  it.live(
    "clears provider errors when the revert becomes permanent",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const session = yield* sessions.create({})
          const providerID = ProviderV2.ID.make("test")
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 1,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "error",
            error: MessageV2.fromError(new Error("Provider returned error"), { providerID }),
          })
          const kept = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "keep",
          })
          const boundary = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "remove",
          })

          yield* sessions.setRevert({
            sessionID: session.id,
            revert: { messageID: assistant.id, partID: boundary.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* revert.cleanup(yield* sessions.get(session.id))

          const messages = yield* sessions.messages({ sessionID: session.id })
          const result = messages.find((message) => message.info.id === assistant.id)
          expect(result?.parts.map((part) => part.id)).toEqual([kept.id])
          expect(result?.info).not.toHaveProperty("error")
        }),
      { git: true },
    ),
  )
})

describe("workspace revert status", () => {
  it.live(
    "reports disabled snapshots when conversation-only revert leaves files unchanged",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const session = yield* sessions.create({})
          const file = path.join(dir, "created.txt")
          const providerID = ProviderV2.ID.make("test")
          yield* Effect.promise(() => fs.writeFile(file, "created"))
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "create a file",
          })

          const result = yield* revert.revert({ sessionID: session.id, messageID: user.id })

          expect(result.revert?.workspace).toBe("snapshots-disabled")
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("created")
        }),
      { git: true, config: { snapshot: false } },
    ),
  )

  it.live(
    "reports unavailable when historical turns have no file checkpoint",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const session = yield* sessions.create({})
          const file = path.join(dir, "created.txt")
          const providerID = ProviderV2.ID.make("test")
          yield* Effect.promise(() => fs.writeFile(file, "created"))
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "create a file",
          })

          const result = yield* revert.revert({ sessionID: session.id, messageID: user.id })

          expect(result.revert?.workspace).toBe("unavailable")
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("created")
        }),
      { git: true },
    ),
  )

  it.live(
    "reports restored when historical patches restore a file",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const session = yield* sessions.create({})
          const file = path.join(dir, "tracked.txt")
          const providerID = ProviderV2.ID.make("test")
          yield* Effect.promise(() => fs.writeFile(file, "before"))
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "change a file",
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          const before = yield* snapshot.track()
          if (!before) throw new Error("expected snapshot")
          yield* Effect.promise(() => fs.writeFile(file, "after"))
          const after = yield* snapshot.track()
          if (!after) throw new Error("expected snapshot")
          const patch = yield* snapshot.patch(before)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-start",
            snapshot: before,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-finish",
            reason: "stop",
            snapshot: after,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })

          const result = yield* revert.revert({ sessionID: session.id, messageID: user.id })

          expect(result.revert?.workspace).toBe("restored")
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("before")
        }),
      { git: true },
    ),
  )

  guarded(
    "keeps the conversation and workspace unchanged when a checkpoint cannot be fully restored",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const item = yield* setup(dir)
          yield* Effect.promise(() => fs.chmod(item.protected, 0o444))
          yield* Effect.promise(() => fs.chmod(item.locked, 0o555))
          const outcome = yield* item.revert.revert({ sessionID: item.session.id, messageID: item.user.id }).pipe(
            Effect.exit,
            Effect.ensuring(
              Effect.promise(async () => {
                await fs.chmod(item.locked, 0o755)
                await fs.chmod(item.protected, 0o644)
              }),
            ),
          )
          const current = yield* item.sessions.get(item.session.id)
          const actual = {
            failed: Exit.isFailure(outcome),
            reverted: current.revert !== undefined,
            protected: yield* Effect.promise(() => fs.readFile(item.protected, "utf8")),
            writable: yield* Effect.promise(() => fs.readFile(item.writable, "utf8")),
          }

          expect(actual).toEqual({
            failed: true,
            reverted: false,
            protected: "after",
            writable: "after",
          })
        }),
      { git: true },
    ),
    30_000,
  )

  guarded(
    "keeps the reverted state when unrevert cannot fully restore files",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const item = yield* setup(dir)
          yield* item.revert.revert({ sessionID: item.session.id, messageID: item.user.id })
          yield* Effect.promise(() => fs.chmod(item.protected, 0o444))
          yield* Effect.promise(() => fs.chmod(item.locked, 0o555))
          const outcome = yield* item.revert.unrevert({ sessionID: item.session.id }).pipe(
            Effect.exit,
            Effect.ensuring(
              Effect.promise(async () => {
                await fs.chmod(item.locked, 0o755)
                await fs.chmod(item.protected, 0o644)
              }),
            ),
          )
          const current = yield* item.sessions.get(item.session.id)

          expect({
            failed: Exit.isFailure(outcome),
            reverted: current.revert !== undefined,
            protected: yield* Effect.promise(() => fs.readFile(item.protected, "utf8")),
            writable: yield* Effect.promise(() => fs.readFile(item.writable, "utf8")),
          }).toEqual({ failed: true, reverted: true, protected: "before", writable: "before" })
        }),
      { git: true },
    ),
    30_000,
  )

  guarded(
    "keeps the prior revert when replacing its checkpoint cannot restore files",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const item = yield* setup(dir)
          yield* item.revert.revert({ sessionID: item.session.id, messageID: item.user.id })
          yield* Effect.promise(() => fs.chmod(item.protected, 0o444))
          yield* Effect.promise(() => fs.chmod(item.locked, 0o555))
          const outcome = yield* item.revert.revert({ sessionID: item.session.id, messageID: item.user.id }).pipe(
            Effect.exit,
            Effect.ensuring(
              Effect.promise(async () => {
                await fs.chmod(item.locked, 0o755)
                await fs.chmod(item.protected, 0o644)
              }),
            ),
          )
          const current = yield* item.sessions.get(item.session.id)

          expect({
            failed: Exit.isFailure(outcome),
            reverted: current.revert !== undefined,
            protected: yield* Effect.promise(() => fs.readFile(item.protected, "utf8")),
            writable: yield* Effect.promise(() => fs.readFile(item.writable, "utf8")),
          }).toEqual({ failed: true, reverted: true, protected: "before", writable: "before" })
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "unreverts deleted files from a session rooted in a worktree subdirectory",
    provideTmpdirInstance(
      (root) =>
        Effect.gen(function* () {
          const dir = path.join(root, "nested")
          yield* Effect.promise(() => fs.mkdir(dir))
          const item = yield* setup(dir, true)
          yield* item.revert.revert({ sessionID: item.session.id, messageID: item.user.id })
          expect(yield* Effect.promise(() => fs.readFile(item.protected, "utf8"))).toBe("before")

          yield* KiloSessionRevert.restore(item.snapshot, item.after, item.patch.files).pipe(provideInstance(dir))

          expect(
            yield* Effect.promise(() =>
              fs.stat(item.protected).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(item.writable, "utf8"))).toBe("after")
        }),
      { git: true },
    ),
    30_000,
  )
})

// The webview "Undo all" / "Confirm undo" cluster posts discardSessionChanges,
// which the extension host forwards to SessionRevert.discardChanges. These prove
// the files-only discard actually restores the workspace end to end (modify and
// create) while leaving the conversation intact and arming no redo boundary, so
// a real-world "Confirm undo does nothing" can only stem from a missing patch
// part (snapshot track degraded at runtime), not from this code path.
describe("files-only discard (Undo all)", () => {
  const exists = (file: string) =>
    Effect.promise(() =>
      fs.stat(file).then(
        () => true,
        () => false,
      ),
    )

  it.live(
    "discardChanges reverts every edited file and keeps the conversation",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const item = yield* setup(dir)
          const before = yield* item.sessions.messages({ sessionID: item.session.id })

          const updated = yield* item.revert.discardChanges({ sessionID: item.session.id })

          expect(yield* Effect.promise(() => fs.readFile(item.protected, "utf8"))).toBe("before")
          expect(yield* Effect.promise(() => fs.readFile(item.writable, "utf8"))).toBe("before")
          // Undoing file edits must not arm a redo boundary or drop any messages.
          expect(updated.revert).toBeUndefined()
          const after = yield* item.sessions.messages({ sessionID: item.session.id })
          expect(after.length).toBe(before.length)
          // The discard records a one-shot note so the model learns its edits were undone.
          const noted = RayaRevertNote.take(item.session.id)
          expect(noted?.some((file) => file.endsWith("writable.txt"))).toBe(true)
          expect(RayaRevertNote.reminder(noted)).toContain("restored to their state before your edits")
          // The note is consumed exactly once.
          expect(RayaRevertNote.take(item.session.id)).toBeUndefined()
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "discardChanges removes a file the turn newly created",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const session = yield* sessions.create({})
          const providerID = ProviderV2.ID.make("test")
          const created = path.join(dir, "greeting.txt")
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          // Track before the file exists so the patch records its creation.
          const base = yield* snapshot.track()
          if (!base) throw new Error("expected snapshot")
          yield* Effect.promise(() => fs.writeFile(created, "hello"))
          const patch = yield* snapshot.patch(base)
          expect(patch.files.some((file) => file.endsWith("greeting.txt"))).toBe(true)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })

          yield* revert.discardChanges({ sessionID: session.id })

          expect(yield* exists(created)).toBe(false)
        }),
      { git: true },
    ),
    30_000,
  )

  // raya_change - per-file Undo must step back exactly one edit. Two sequential edits to the
  // same file ("" -> "Welcome" -> "Good day"); undoing the file restores "Welcome" (the prior
  // edit) rather than deleting the greeting by rewinding to the pre-session baseline.
  it.live(
    "per-file discard steps back to the previous edit, not the first baseline",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const session = yield* sessions.create({})
          const providerID = ProviderV2.ID.make("test")
          const notes = path.join(dir, "notes.txt")
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          const commit = (hash: string, files: string[]) =>
            sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "patch",
              hash,
              files,
            })

          // Edit 1: create the file with "Welcome".
          const base0 = yield* snapshot.track()
          if (!base0) throw new Error("expected snapshot")
          yield* Effect.promise(() => fs.writeFile(notes, "Welcome"))
          const patch1 = yield* snapshot.patch(base0)
          yield* commit(patch1.hash, patch1.files)

          // Edit 2: change "Welcome" to "Good day".
          const base1 = yield* snapshot.track()
          if (!base1) throw new Error("expected snapshot")
          yield* Effect.promise(() => fs.writeFile(notes, "Good day"))
          const patch2 = yield* snapshot.patch(base1)
          yield* commit(patch2.hash, patch2.files)

          yield* revert.discardChanges({ sessionID: session.id, files: [notes] })

          expect(yield* Effect.promise(() => fs.readFile(notes, "utf8"))).toBe("Welcome")
        }),
      { git: true },
    ),
    30_000,
  )

  // raya_change - Keep must fence Undo. After "date" is written and kept, adding
  // "time" then Undo all must step back to the kept "date", NOT wipe everything to
  // the pre-session empty file (the reported "Keep all then Undo all deletes the
  // date too" regression). Each turn is its own assistant message so the kept
  // boundary (a message id) sits strictly before the post-keep edit.
  it.live(
    "keepChanges fences a later Undo all to the kept content, not the session baseline",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const session = yield* sessions.create({})
          const providerID = ProviderV2.ID.make("test")
          const notes = path.join(dir, "notes.txt")

          const turn = Effect.fn(function* (write: string, before: string) {
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: "default",
              model: { providerID, modelID: ModelV2.ID.make("test") },
              time: { created: Date.now() },
            })
            const assistant = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "assistant",
              parentID: user.id,
              mode: "default",
              agent: "default",
              path: { cwd: dir, root: dir },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelV2.ID.make("test"),
              providerID,
              time: { created: Date.now() },
              finish: "end_turn",
            })
            const base = yield* snapshot.track()
            if (!base) throw new Error("expected snapshot")
            yield* Effect.promise(() => fs.writeFile(notes, write))
            const patch = yield* snapshot.patch(base)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return before
          })

          // Turn 1: write the date. Turn 2 (after Keep) appends the time.
          yield* turn("2026-09-03", "")
          yield* revert.keepChanges({ sessionID: session.id }) // Keep all
          yield* turn("2026-09-03\n17:00", "2026-09-03")

          // Undo all must land on the kept content, not the empty pre-session file.
          yield* revert.discardChanges({ sessionID: session.id })
          expect(yield* Effect.promise(() => fs.readFile(notes, "utf8"))).toBe("2026-09-03")

          // A second Undo all has nothing below the keep to rewind — the date stays.
          yield* revert.discardChanges({ sessionID: session.id })
          expect(yield* Effect.promise(() => fs.readFile(notes, "utf8"))).toBe("2026-09-03")
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "discardChanges on the parent reverts a file a child subagent edited",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const providerID = ProviderV2.ID.make("test")
          const file = path.join(dir, "greeting.txt")
          yield* Effect.promise(() => fs.writeFile(file, "before"))

          // Parent turn (agent=auto) delegates via the task tool. It records NO
          // patch part of its own — mirroring the real orchestrator turn.
          const parent = yield* sessions.create({})
          const parentUser = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: parent.id,
            role: "user",
            agent: "auto",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: parent.id,
            role: "assistant",
            parentID: parentUser.id,
            mode: "default",
            agent: "auto",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID,
            time: { created: Date.now() },
            finish: "end_turn",
          })

          // Child subagent session (edit/write denied → it edits via bash), which
          // is where the patch part actually lands.
          const child = yield* sessions.create({ parentID: parent.id })
          const childAssistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: child.id,
            role: "assistant",
            parentID: parentUser.id,
            mode: "default",
            agent: "generalist",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          const base = yield* snapshot.track()
          if (!base) throw new Error("expected snapshot")
          yield* Effect.promise(() => fs.writeFile(file, "after"))
          const patch = yield* snapshot.patch(base)
          expect(patch.files.some((f) => f.endsWith("greeting.txt"))).toBe(true)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: childAssistant.id,
            sessionID: child.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })

          // Undo all is invoked on the displayed PARENT session, which owns no
          // patch part. It must still restore the child subagent's edit.
          yield* revert.discardChanges({ sessionID: parent.id })

          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("before")
        }),
      { git: true },
    ),
    30_000,
  )
})
