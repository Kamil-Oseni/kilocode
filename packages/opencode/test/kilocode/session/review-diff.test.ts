import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { spans } from "@/kilocode/session/review-diff"
import { provideTmpdirProject } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const env = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    SessionSummary.node,
    Snapshot.node,
    Storage.node,
    Database.node,
    CrossSpawnSpawner.node,
  ]),
)
const it = testEffect(env)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test")

it.live(
  "refuses a blind descendant before replaying parent patches, even across concurrent reviews",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const storage = yield* Storage.Service
        const snapshot = yield* Snapshot.Service
        const parent = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: parent.id })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: parent.id,
          role: "user",
          agent: "auto",
          model: { providerID, modelID },
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: parent.id,
          role: "assistant",
          parentID: user.id,
          mode: "default",
          agent: "coder",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens,
          modelID,
          providerID,
          time: { created: Date.now() },
          finish: "end_turn",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: parent.id,
          type: "step-start",
          snapshot: "start",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: parent.id,
          type: "step-finish",
          reason: "stop",
          snapshot: "finish",
          cost: 0,
          tokens,
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: parent.id,
          type: "patch",
          hash: "start",
          files: [path.join(dir, "a.txt")],
        })
        const childUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: child.id,
          role: "user",
          agent: "coder",
          model: { providerID, modelID },
          time: { created: Date.now() },
        })
        const childAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: child.id,
          role: "assistant",
          parentID: childUser.id,
          mode: "default",
          agent: "coder",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens,
          modelID,
          providerID,
          time: { created: Date.now() },
          finish: "end_turn",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: childAssistant.id,
          sessionID: child.id,
          type: "tool",
          tool: "bash",
          callID: "call-blind",
          state: {
            status: "completed",
            input: { command: "edit a.txt" },
            output: "",
            metadata: {},
            title: "Edit a.txt",
            time: { start: Date.now(), end: Date.now() },
          },
        })

        let calls = 0
        const snap: Snapshot.Interface = {
          ...snapshot,
          patch: () => {
            calls++
            return Effect.die(new Error("patch was replayed before review refusal"))
          },
        }
        const results = yield* Effect.forEach(
          Array.from({ length: 8 }),
          () => Effect.exit(spans(snap, storage, sessions, parent.id)),
          { concurrency: "unbounded" },
        )
        expect(calls).toBe(0)
        for (const result of results) {
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("without a completed snapshot")
        }
      }),
    { git: true },
  ),
  30_000,
)

it.live(
  "hides kept raw additions and refuses a later edit without snapshots",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const storage = yield* Storage.Service
        const parent = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: parent.id })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: parent.id,
          role: "user",
          agent: "auto",
          model: { providerID, modelID },
          time: { created: Date.now() },
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: child.id,
          role: "user",
          agent: "coder",
          model: { providerID, modelID },
          time: { created: Date.now() },
        })
        yield* storage.write(
          ["session_diff", parent.id],
          [{ file: "b.txt", patch: "+original", additions: 1, deletions: 0, status: "added" }],
        )
        yield* storage.write(["session_kept", parent.id], { [path.join(dir, "b.txt")]: user.id })
        expect(yield* summary.diff({ sessionID: parent.id })).toEqual([])
        expect(yield* summary.diff({ sessionID: parent.id, full: true, file: "b.txt" })).toEqual([])

        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: child.id,
          role: "assistant",
          parentID: user.id,
          mode: "default",
          agent: "coder",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens,
          modelID,
          providerID,
          time: { created: Date.now() },
          finish: "end_turn",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: child.id,
          type: "tool",
          tool: "bash",
          callID: "call-delete-b",
          state: {
            status: "completed",
            input: { command: "Remove-Item b.txt" },
            output: "",
            metadata: {},
            title: "Delete b.txt",
            time: { start: Date.now(), end: Date.now() },
          },
        })
        expect(Exit.isFailure(yield* Effect.exit(summary.diff({ sessionID: parent.id })))).toBe(true)
      }),
    { git: true },
  ),
  30_000,
)

it.live(
  "refuses a historical deletion after a hunk discard restores different live bytes",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const snapshot = yield* Snapshot.Service
        const storage = yield* Storage.Service
        const session = yield* sessions.create({})
        const file = path.join(dir, "a.txt")
        yield* Effect.promise(() => fs.writeFile(file, "original"))
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          agent: "auto",
          model: { providerID, modelID },
          time: { created: Date.now() },
        })
        yield* storage.write(
          ["session_diff", session.id],
          [{ file: "a.txt", patch: "+original", additions: 1, deletions: 0, status: "added" }],
        )
        yield* storage.write(["session_kept", session.id], { [file]: user.id })
        const start = yield* snapshot.track({ snapshotInitialization: "wait" })
        if (!start) throw new Error("missing start snapshot")
        yield* Effect.promise(() => fs.rm(file))
        const finish = yield* snapshot.track({ snapshotInitialization: "wait" })
        if (!finish) throw new Error("missing finish snapshot")
        const patch = yield* snapshot.patch(start, finish)
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          parentID: user.id,
          mode: "default",
          agent: "coder",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens,
          modelID,
          providerID,
          time: { created: Date.now() },
          finish: "end_turn",
        })
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
        expect((yield* summary.diff({ sessionID: session.id })).map((diff) => diff.status)).toEqual(["deleted"])
        yield* Effect.promise(() => fs.writeFile(file, "original\n"))
        expect(Exit.isFailure(yield* Effect.exit(summary.diff({ sessionID: session.id })))).toBe(true)
      }),
    { git: true },
  ),
  45_000,
)
