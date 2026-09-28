import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Global } from "@opencode-ai/core/global"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
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
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../../fixture/fixture"
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

it.live(
  "reviews and undoes a foreign child worktree without aliasing the parent's same-named file",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const revert = yield* SessionRevert.Service
        const snapshot = yield* Snapshot.Service
        const storage = yield* Storage.Service
        const parent = yield* sessions.create({})
        const branch = path.join(dir, "branch")
        yield* Effect.promise(async () => {
          const proc = Bun.spawn(["git", "worktree", "add", "--detach", branch], {
            cwd: dir,
            stdout: "ignore",
            stderr: "pipe",
          })
          const failure = await new Response(proc.stderr).text()
          if ((await proc.exited) !== 0) throw new Error(failure)
        })
        const own = path.join(dir, "notes.txt")
        const file = path.join(branch, "notes.txt")
        yield* Effect.promise(() => fs.writeFile(own, "parent safe"))
        const child = yield* Effect.gen(function* () {
          const session = yield* sessions.create({ parentID: parent.id })
          const providerID = ProviderV2.ID.make("test")
          const modelID = ModelV2.ID.make("test")
          const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID },
            time: { created: Date.now() },
          })
          yield* Effect.promise(() => fs.writeFile(file, "child original"))
          const start = yield* snapshot.track({ snapshotInitialization: "wait" })
          if (!start) throw new Error("Missing child start snapshot")
          yield* Effect.promise(() => fs.writeFile(file, "child edited"))
          const finish = yield* snapshot.track({ snapshotInitialization: "wait" })
          if (!finish) throw new Error("Missing child finish snapshot")
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: branch, root: branch },
            cost: 0,
            tokens,
            modelID,
            providerID,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          const patch = yield* snapshot.patch(start, finish)
          expect(yield* snapshot.checkpoints([{ hash: start, files: [file] }])).toBe(true)
          expect(yield* snapshot.checkpoints([{ hash: "0".repeat(40), files: [file] }])).toBe(false)
          expect(yield* snapshot.checkpoints([{ hash: "--help", files: [file] }])).toBe(false)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-start",
            snapshot: start,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-finish",
            reason: "stop",
            snapshot: finish,
            cost: 0,
            tokens,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })
          yield* storage.write(["session_diff", session.id], yield* snapshot.diffFull(start, finish))
          return session
        }).pipe(provideInstance(branch))
        const diffs = yield* summary.diff({ sessionID: parent.id })
        const diff = diffs.find((item) => item.file === file)
        if (!diff) throw new Error("Missing parent review of foreign file")
        expect(diff.patch).toContain("-child original")
        expect(diff.patch).toContain("+child edited")
        expect(diffs.some((item) => item.file === own)).toBe(false)
        const detail = yield* summary.diff({ sessionID: parent.id, file, full: true })
        expect(detail[0]).toMatchObject({ before: "child original", after: "child edited" })
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              revert.discardChanges({ sessionID: parent.id, expected: {}, requestID: "foreign-parent-review" }),
            ),
          ),
        ).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(own, "utf8"))).toBe("parent safe")
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("child edited")
        const request = {
          sessionID: parent.id,
          files: [file],
          expected: { [file]: revision(diff) },
          requestID: "parent-foreign-undo",
        }
        yield* revert.discardChanges(request)
        const key = ["review_receipt", parent.id, createHash("sha256").update(request.requestID).digest("hex")]
        const saved = yield* storage.read<{ complete: boolean; proof: { version: number; groups: unknown[] } }>(key)
        expect(saved.proof.version).toBe(2)
        expect(saved.proof.groups).toHaveLength(1)
        yield* storage.replace(key, { ...saved, complete: false })
        yield* storage.remove(["session_undo", parent.id])
        yield* Effect.promise(() => fs.writeFile(file, "manual child"))
        expect(Exit.isFailure(yield* Effect.exit(revert.discardChanges(request)))).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("manual child")
        yield* Effect.promise(() => fs.writeFile(file, "child original"))
        yield* revert.discardChanges(request)
        yield* Effect.gen(function* () {
          expect(yield* summary.diff({ sessionID: child.id })).toEqual([])
        }).pipe(provideInstance(branch))
        expect(yield* Effect.promise(() => fs.readFile(own, "utf8"))).toBe("parent safe")
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("child original")
        expect(yield* summary.diff({ sessionID: parent.id })).toEqual([])
        const messages = yield* sessions.messages({ sessionID: child.id })
        const original = messages.find((message) => message.info.role === "assistant")
        if (!original || original.info.role !== "assistant") throw new Error("Missing child assistant")
        const report = yield* sessions.updateMessage({ ...original.info, id: MessageID.ascending() })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: report.id,
          sessionID: child.id,
          type: "text",
          text: "The child-local Undo is complete.",
        })
        expect(yield* summary.diff({ sessionID: parent.id })).toEqual([])
        yield* Effect.promise(() => fs.writeFile(file, "child edited"))
        const fresh = yield* sessions.updateMessage({ ...original.info, id: MessageID.ascending() })
        for (const part of original.parts)
          if (["step-start", "step-finish", "patch"].includes(part.type))
            yield* sessions.updatePart({ ...part, id: PartID.ascending(), messageID: fresh.id })
        const pending = yield* summary.diff({ sessionID: parent.id })
        const edited = pending.find((item) => item.file === file)
        if (!edited) throw new Error("Missing fresh foreign review after Undo")
        const keep = {
          sessionID: parent.id,
          expected: { [file]: revision(edited) },
          requestID: "parent-foreign-keep",
        }
        yield* revert.keepChanges(keep)
        yield* revert.keepChanges(keep)
        expect(yield* summary.diff({ sessionID: parent.id })).toEqual([])
        yield* Effect.gen(function* () {
          expect(yield* summary.diff({ sessionID: child.id })).toEqual([])
        }).pipe(provideInstance(branch))
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("child edited")
        expect(yield* Effect.promise(() => fs.readFile(own, "utf8"))).toBe("parent safe")
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: report.id,
          sessionID: child.id,
          type: "tool",
          tool: "write",
          callID: "foreign-uncaptured-write",
          state: {
            status: "completed",
            input: { filePath: file, content: "unknown" },
            output: "",
            metadata: {},
            title: "Uncaptured child write",
            time: { start: Date.now(), end: Date.now() },
          },
        })
        expect(Exit.isFailure(yield* Effect.exit(summary.diff({ sessionID: parent.id })))).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(own, "utf8"))).toBe("parent safe")
      }),
    { git: true },
  ),
  90_000,
)

it.live(
  "recovers sequential Undo after an OS process restart without replaying an unknown action",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      const control = path.join(root, "control.json")
      const file = path.join(dir, "notes.txt")
      const fixture = fileURLToPath(new URL("./fixtures/review-restart.ts", import.meta.url))
      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          pid: Schema.Number,
          bytes: Schema.String,
          refused: Schema.optional(Schema.Boolean),
          final: Schema.optional(Schema.String),
          detail: Schema.optional(
            Schema.Array(
              Schema.Struct({ before: Schema.optional(Schema.String), after: Schema.optional(Schema.String) }),
            ),
          ),
          remaining: Schema.optional(Schema.Array(Schema.Unknown)),
        }),
      )
      const launch = (mode: string) =>
        Bun.spawn([process.execPath, fixture, mode, dir, control], {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_STATE_HOME: path.join(root, "state"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            KILO_TEST_HOME: path.join(root, "home"),
            KILO_DB: path.join(root, "review.sqlite"),
          },
        })
      const first = yield* Effect.promise(async () => {
        const proc = launch("seed")
        const reader = proc.stdout.getReader()
        const timeout = setTimeout(() => proc.kill(), 60_000)
        try {
          const chunks: string[] = []
          while (!/REVIEW_READY [^\n]*\n/.test(chunks.join(""))) {
            const next = await reader.read()
            if (next.done) throw new Error(await new Response(proc.stderr).text())
            chunks.push(new TextDecoder().decode(next.value))
          }
          const line = chunks
            .join("")
            .split("\n")
            .find((item) => item.startsWith("REVIEW_READY "))
          if (!line) throw new Error("Missing stopped process evidence")
          return result(JSON.parse(line.slice("REVIEW_READY ".length)))
        } finally {
          clearTimeout(timeout)
          proc.kill()
          await proc.exited
          reader.releaseLock()
        }
      })
      expect(first.bytes).toBe("B")
      const run = (mode: string) =>
        Effect.promise(async () => {
          const proc = launch(mode)
          const timeout = setTimeout(() => proc.kill(), 60_000)
          try {
            const [output, failure, code] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])
            if (code !== 0) throw new Error(failure)
            const line = output.split("\n").find((item) => item.startsWith("REVIEW_RESULT "))
            if (!line) throw new Error(`Missing restarted process evidence: ${output}`)
            return result(JSON.parse(line.slice("REVIEW_RESULT ".length)))
          } finally {
            clearTimeout(timeout)
            if (proc.exitCode === null) proc.kill()
            await proc.exited
          }
        })
      yield* Effect.promise(() => fs.writeFile(file, "manual"))
      const unknown = yield* run("unknown")
      expect(unknown.pid).not.toBe(first.pid)
      expect(unknown).toMatchObject({ refused: true, bytes: "manual" })
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("manual")
      yield* Effect.promise(() => fs.writeFile(file, "B"))
      const resumed = yield* run("resume")
      expect(resumed.pid).not.toBe(first.pid)
      expect(resumed.pid).not.toBe(unknown.pid)
      expect(resumed).toMatchObject({ bytes: "B", final: "A", remaining: [] })
      expect(resumed.detail?.[0]).toMatchObject({ before: "A", after: "B" })
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("A")
    }),
  180_000,
)

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

it.live(
  "projects a polluted saved patch through its completed step for review, Keep and Undo",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const state = yield* setup(dir)
        const storage = yield* Storage.Service
        const summary = yield* SessionSummary.Service
        const late = path.join(dir, "late.txt")
        const providerID = ProviderV2.ID.make("test")
        const save = Effect.fn("ReviewLegacyPatch.save")(function* (start: string, finish: string, files: string[]) {
          const assistant = yield* state.sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: state.session.id,
            role: "assistant",
            parentID: state.user.id,
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
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: state.session.id,
            type: "step-start",
            snapshot: start,
          })
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: state.session.id,
            type: "step-finish",
            reason: "stop",
            snapshot: finish,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          const part = yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: state.session.id,
            type: "patch",
            hash: start,
            files,
          })
          return { assistant, part }
        })

        yield* Effect.promise(() => fs.writeFile(late, "kept"))
        const written = yield* state.snapshot.track()
        if (!written) throw new Error("expected completed snapshot")
        const valid = yield* save(state.after, written, [late])
        const polluted = yield* save(state.patch.hash, state.after, [state.writable, late])
        yield* state.sessions.updatePart({
          id: PartID.ascending(),
          messageID: polluted.assistant.id,
          sessionID: state.session.id,
          type: "patch",
          hash: state.patch.hash,
          files: [late],
        })
        const diffs = yield* state.snapshot.diffFull(state.patch.hash, written)
        yield* storage.write(["session_diff", state.session.id], diffs)
        const review = yield* summary.diff({ sessionID: state.session.id })
        const owned = review.find(
          (diff) => diff.file && path.resolve(dir, diff.file).replaceAll("\\", "/") === late.replaceAll("\\", "/"),
        )
        expect(owned?.generation).toBe(`${valid.assistant.id}:${valid.part.id}`)
        expect(owned?.generation).not.toBe(`${polluted.assistant.id}:${polluted.part.id}`)
        const expected = Object.fromEntries(
          review.filter((diff) => diff.file).map((diff) => [diff.file!, revision(diff)]),
        )
        yield* state.revert.keepChanges({ sessionID: state.session.id, expected })
        const kept = yield* storage.read<Record<string, string>>(["session_kept", state.session.id])
        expect(kept[late.replaceAll("\\", "/")]).toBe(valid.assistant.id)

        yield* Effect.promise(() => fs.writeFile(late, "newer"))
        const newer = yield* state.snapshot.track()
        if (!newer) throw new Error("expected newer snapshot")
        yield* save(written, newer, [late])
        yield* storage.write(
          ["session_diff", state.session.id],
          yield* state.snapshot.diffFull(state.patch.hash, newer),
        )
        const current = yield* summary.diff({ sessionID: state.session.id })
        const next = Object.fromEntries(current.filter((diff) => diff.file).map((diff) => [diff.file!, revision(diff)]))
        yield* state.revert.discardChanges({ sessionID: state.session.id, expected: next })
        expect(yield* Effect.promise(() => fs.readFile(late, "utf8"))).toBe("kept")
        expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("after")
      }),
    { git: true },
  ),
  90_000,
)

for (const git of [true, false])
  it.live(
    `reviews a later child deletion after keeping a child-created file from its actual ${git ? "Git" : "non-Git"} snapshot`,
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* setup(dir)
          const storage = yield* Storage.Service
          const summary = yield* SessionSummary.Service
          const file = path.join(dir, "raya-review-fresh-a.txt")
          const child = yield* state.sessions.create({ parentID: state.session.id })
          const providerID = ProviderV2.ID.make("test")
          const user = yield* state.sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: child.id,
            role: "user",
            agent: "auto",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          const save = Effect.fn("ReviewChildDelete.save")(function* (
            sessionID: typeof state.session.id,
            parentID: typeof user.id,
            start: string,
            finish: string,
          ) {
            const assistant = yield* state.sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID,
              role: "assistant",
              parentID,
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
            yield* state.sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID,
              type: "step-start",
              snapshot: start,
            })
            yield* state.sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID,
              type: "step-finish",
              reason: "stop",
              snapshot: finish,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            yield* state.sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID,
              type: "patch",
              hash: start,
              files: [file],
            })
            return assistant
          })
          yield* Effect.promise(() => fs.writeFile(file, "fresh worker A"))
          const created = yield* state.snapshot.track()
          if (!created) throw new Error("expected child snapshot")
          yield* save(child.id, user.id, state.after, created)
          yield* storage.write(["session_diff", child.id], yield* state.snapshot.diffFull(state.after, created))
          yield* storage.write(
            ["session_diff", state.session.id],
            yield* state.snapshot.diffFull(state.patch.hash, state.after),
          )
          const initial = (yield* summary.diff({ sessionID: state.session.id })).find(
            (diff) => diff.file === path.basename(file),
          )
          expect(initial?.status).toBe("added")
          yield* state.revert.keepChanges({
            sessionID: state.session.id,
            files: [file],
            expected: { [file]: revision(initial!) },
            requestID: "keep-child-created-file",
          })
          yield* Effect.promise(() => fs.rm(file))
          const removed = yield* state.snapshot.track()
          if (!removed) throw new Error("expected deletion snapshot")
          const deleter = yield* state.sessions.create({ parentID: state.session.id })
          const request = yield* state.sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: deleter.id,
            role: "user",
            agent: "auto",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* save(deleter.id, request.id, created, removed)
          yield* storage.write(["session_diff", deleter.id], yield* state.snapshot.diffFull(created, removed))
          yield* summary.summarize({ sessionID: state.session.id, messageID: state.user.id })
          expect((yield* state.sessions.get(state.session.id)).summary).toMatchObject({
            files: 3,
            additions: 2,
            deletions: 3,
          })
          const current = (yield* summary.diff({ sessionID: state.session.id })).find(
            (diff) => diff.file === path.basename(file),
          )
          expect(current?.status).toBe("deleted")
          expect(current?.deletions).toBe(1)
          expect(current?.reviewed).toBe("")
          const full = yield* summary.diff({ sessionID: state.session.id, file: path.basename(file), full: true })
          expect(full[0]).toMatchObject({
            file: path.basename(file),
            status: "deleted",
            before: "fresh worker A",
            after: "",
          })
          expect(
            (yield* Effect.flip(
              state.revert.keepChanges({
                sessionID: state.session.id,
                files: [file],
                expected: { [file]: revision(initial!) },
                requestID: "stale-child-revision",
              }),
            ))._tag,
          ).toBe("ReviewConflict")
          yield* state.revert.discardChanges({
            sessionID: state.session.id,
            files: [file],
            expected: { [file]: revision(current!) },
            requestID: "undo-parent-deletion",
          })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("fresh worker A")
        }),
      { git },
    ),
    120_000,
  )

it.live(
  "keeps and later undoes a new file in a non-Git workspace with exact snapshots",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const state = yield* setup(dir)
        const storage = yield* Storage.Service
        const summary = yield* SessionSummary.Service
        const file = path.join(dir, "created.txt")
        const providerID = ProviderV2.ID.make("test")
        const save = Effect.fn("ReviewAddedFile.save")(function* (before: string, after: string) {
          const assistant = yield* state.sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: state.session.id,
            role: "assistant",
            parentID: state.user.id,
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
          const patch = yield* state.snapshot.patch(before, after)
          expect(patch.files).toContain(file.replaceAll("\\", "/"))
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: state.session.id,
            type: "step-start",
            snapshot: before,
          })
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: state.session.id,
            type: "step-finish",
            reason: "stop",
            snapshot: after,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          yield* state.sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: state.session.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })
        })

        const base = state.after
        yield* Effect.promise(() => fs.writeFile(file, "kept"))
        const first = yield* state.snapshot.track()
        if (!first) throw new Error("expected first snapshot")
        yield* save(base, first)
        yield* storage.write(["session_diff", state.session.id], yield* state.snapshot.diffFull(base, first))
        const one = (yield* summary.diff({ sessionID: state.session.id })).find((diff) => diff.file === "created.txt")!
        yield* state.revert.keepChanges({
          sessionID: state.session.id,
          files: [file],
          expected: { [one.file!]: revision(one) },
        })
        expect(
          (yield* summary.diff({ sessionID: state.session.id })).find((diff) => diff.file === "created.txt"),
        ).toBeUndefined()

        yield* Effect.promise(() => fs.writeFile(file, "later edit"))
        const second = yield* state.snapshot.track()
        if (!second) throw new Error("expected second snapshot")
        yield* save(first, second)
        yield* storage.write(["session_diff", state.session.id], yield* state.snapshot.diffFull(base, second))
        const two = (yield* summary.diff({ sessionID: state.session.id })).find((diff) => diff.file === "created.txt")!
        yield* state.revert.discardChanges({
          sessionID: state.session.id,
          files: [file],
          expected: { [two.file!]: revision(two) },
        })
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("kept")
      }),
    { git: false },
  ),
  120_000,
)

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
                gate.withWorkspace(state.session.directory)(
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
              .withWorkspace(state.session.directory)(
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
            const summary = yield* SessionSummary.Service
            const expected = Object.fromEntries(
              (yield* summary.diff({ sessionID: state.session.id })).map((diff) => [diff.file!, revision(diff)]),
            )
            const operation =
              action === "remove"
                ? state.sessions.remove(state.session.id).pipe(Effect.orDie)
                : state.revert[action]({ sessionID: state.session.id, expected }).pipe(Effect.asVoid, Effect.orDie)
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
    "session deletion erases its review receipts after retaining them for delayed retries",
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
          yield* state.revert.keepChanges({ sessionID: state.session.id, expected, requestID: "retained-until-delete" })
          yield* storage.write(["review_receipt", "other-session", "retained"], { complete: true })
          expect(yield* storage.list(["review_receipt", state.session.id])).toHaveLength(1)
          yield* state.sessions.remove(state.session.id)
          expect(yield* storage.list(["review_receipt", state.session.id])).toEqual([])
          expect(yield* storage.list(["review_receipt", "other-session"])).toHaveLength(1)
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "a failed review preparation leaves no receipt and permits a corrected retry",
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
          expect(yield* storage.list(["review_receipt", state.session.id])).toEqual([])
          yield* storage.write(["session_kept", state.session.id], {})
          expect((yield* state.revert.discardChanges(input)).id).toBe(state.session.id)
          expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("before")
        }),
      { git: true },
    ),
    30_000,
  )

  for (const action of ["keepChanges", "discardChanges"] as const) {
    it.live(
      `${action} reconciles an incomplete receipt only from its authoritative postcondition`,
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
            const input = { sessionID: state.session.id, expected, requestID: `recover-${action}` }
            expect((yield* state.revert[action](input)).id).toBe(state.session.id)
            const [key] = yield* storage.list(["review_receipt", state.session.id])
            expect(key).toBeDefined()
            const saved = yield* storage.read<Record<string, unknown>>(key)
            yield* storage.replace(key, { ...saved, complete: false })
            expect((yield* state.revert[action](input)).id).toBe(state.session.id)
            expect(yield* storage.read(key)).toMatchObject({ complete: true })
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
    "an incomplete Undo receipt stays uncertain after newer manual work",
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
          const input = { sessionID: state.session.id, expected, requestID: "recover-undo-edited" }
          yield* state.revert.discardChanges(input)
          const [key] = yield* storage.list(["review_receipt", state.session.id])
          expect(key).toBeDefined()
          const saved = yield* storage.read<Record<string, unknown>>(key)
          yield* storage.replace(key, { ...saved, complete: false })
          yield* Effect.promise(() => fs.writeFile(state.writable, "newer manual work"))
          const error = yield* Effect.flip(state.revert.discardChanges(input))
          expect(error._tag).toBe("ReviewConflict")
          expect("message" in error && error.message).toContain("outcome is uncertain")
          expect(yield* Effect.promise(() => fs.readFile(state.writable, "utf8"))).toBe("newer manual work")
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
          const noted = yield* Effect.promise(() => RayaRevertNote.take(item.session.id))
          expect(noted?.some((file) => file.endsWith("writable.txt"))).toBe(true)
          expect(RayaRevertNote.reminder(noted)).toContain("restored to their state before your edits")
          // The note is consumed exactly once.
          expect(yield* Effect.promise(() => RayaRevertNote.take(item.session.id))).toBeUndefined()
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
          const commit = Effect.fnUntraced(function* (hash: string, files: string[]) {
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "step-start",
              snapshot: hash,
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "step-finish",
              snapshot: yield* snapshot.track(),
              reason: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "patch",
              hash,
              files,
            })
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

  it.live(
    "refreshes an intermediate review and permits a second guarded per-file Undo",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const summary = yield* SessionSummary.Service
          const snapshot = yield* Snapshot.Service
          const storage = yield* Storage.Service
          const session = yield* sessions.create({})
          const file = path.join(dir, "notes.txt")
          const providerID = ProviderV2.ID.make("test")
          const modelID = ModelV2.ID.make("test")
          const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          const save = Effect.fn("ReviewStep.save")(function* (start: string, finish: string) {
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: "default",
              model: { providerID, modelID },
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
              tokens,
              modelID,
              providerID,
              time: { created: Date.now() },
              finish: "end_turn",
            })
            const patch = yield* snapshot.patch(start, finish)
            expect(patch.files).toContain(file.replaceAll("\\", "/"))
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "step-start",
              snapshot: start,
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "step-finish",
              reason: "stop",
              snapshot: finish,
              cost: 0,
              tokens,
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: session.id,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          })

          yield* Effect.promise(() => fs.writeFile(file, "A"))
          const first = yield* snapshot.track()
          if (!first) throw new Error("expected first snapshot")
          yield* Effect.promise(() => fs.writeFile(file, "B"))
          const middle = yield* snapshot.track()
          if (!middle) throw new Error("expected middle snapshot")
          yield* save(first, middle)
          yield* Effect.promise(() => fs.writeFile(file, "C"))
          const last = yield* snapshot.track()
          if (!last) throw new Error("expected last snapshot")
          yield* save(middle, last)
          yield* storage.write(["session_diff", session.id], yield* snapshot.diffFull(first, last))

          const current = (yield* summary.diff({ sessionID: session.id })).find((diff) => diff.file === "notes.txt")
          expect(current?.status).toBe("modified")
          expect((yield* summary.diff({ sessionID: session.id, file: "notes.txt", full: true }))[0]).toMatchObject({
            before: "A",
            after: "C",
          })
          const firstUndo = {
            sessionID: session.id,
            files: [file],
            expected: { [file]: revision(current!) },
            requestID: "undo-latest",
          }
          yield* revert.discardChanges(firstUndo)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("B")

          const [key] = yield* storage.list(["review_receipt", session.id])
          expect(key).toBeDefined()
          const receipt = yield* storage.read<Record<string, unknown>>(key)
          yield* storage.replace(key, { ...receipt, complete: false })
          yield* revert.discardChanges(firstUndo)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("B")
          expect(yield* storage.read(key)).toMatchObject({ complete: true })

          yield* storage.replace(key, { ...receipt, complete: false })
          yield* Effect.promise(() => fs.writeFile(file, "manual"))
          const uncertain = yield* Effect.flip(revert.discardChanges(firstUndo))
          expect(uncertain._tag).toBe("ReviewConflict")
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("manual")
          yield* Effect.promise(() => fs.writeFile(file, "B"))
          yield* revert.discardChanges(firstUndo)
          expect(yield* storage.read(key)).toMatchObject({ complete: true })

          const pending = (yield* summary.diff({ sessionID: session.id })).find((diff) => diff.file === "notes.txt")
          expect(pending?.status).toBe("modified")
          const detail = yield* summary.diff({ sessionID: session.id, file: "notes.txt", full: true })
          expect(detail[0]).toMatchObject({ before: "A", after: "B" })

          yield* Effect.promise(() => fs.writeFile(file, "D"))
          const newer = yield* snapshot.track()
          if (!newer) throw new Error("expected post-Undo snapshot")
          yield* save(middle, newer)
          yield* storage.write(["session_diff", session.id], yield* snapshot.diffFull(first, newer))
          const revised = (yield* summary.diff({ sessionID: session.id })).find((diff) => diff.file === "notes.txt")
          expect(revised?.status).toBe("modified")
          expect((yield* summary.diff({ sessionID: session.id, file: "notes.txt", full: true }))[0]).toMatchObject({
            before: "A",
            after: "D",
          })

          yield* Effect.promise(() => fs.writeFile(file, "B"))
          const repeated = yield* snapshot.track()
          if (!repeated) throw new Error("expected repeated-content snapshot")
          yield* save(newer, repeated)
          yield* storage.write(["session_diff", session.id], yield* snapshot.diffFull(first, repeated))
          const same = (yield* summary.diff({ sessionID: session.id })).find((diff) => diff.file === "notes.txt")
          expect(same?.generation).not.toBe(pending?.generation)
          expect(revision(same!)).not.toBe(revision(pending!))
          yield* revert.discardChanges({
            sessionID: session.id,
            files: [file],
            expected: { [file]: revision(same!) },
            requestID: "undo-repeated-bytes",
          })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("D")
          yield* revert.discardChanges({
            sessionID: session.id,
            files: [file],
            expected: { [file]: revision(revised!) },
            requestID: "undo-post-undo-edit",
          })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("B")
          const remaining = (yield* summary.diff({ sessionID: session.id })).find((diff) => diff.file === "notes.txt")
          expect(remaining?.generation).toBe(pending?.generation)
          yield* revert.discardChanges({
            sessionID: session.id,
            files: [file],
            expected: { [file]: revision(remaining!) },
            requestID: "undo-earlier",
          })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("A")
          expect(yield* summary.diff({ sessionID: session.id })).toEqual([])
        }),
      { git: true },
    ),
    90_000,
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
