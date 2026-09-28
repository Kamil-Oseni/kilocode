import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import * as Project from "@/project/project"
import { revision } from "@/kilocode/session/review-revision"
import { provideInstance, provideTmpdirProject } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const env = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    SessionRevert.node,
    SessionSummary.node,
    Snapshot.node,
    Storage.node,
    CrossSpawnSpawner.node,
    Project.node,
    Database.node,
  ]),
)
const it = testEffect(env)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

it.live(
  "restores two real worker workspaces and refuses invalid later checkpoints or stale bytes before changing either",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const summary = yield* SessionSummary.Service
        const revert = yield* SessionRevert.Service
        const snap = yield* Snapshot.Service
        const storage = yield* Storage.Service
        const parent = yield* sessions.create({})
        const own = path.join(dir, "notes.txt")
        yield* Effect.promise(() => fs.writeFile(own, "parent untouched\r\n"))
        const workers: {
          session: Session.Info
          file: string
          before: string
          after: string
          beginning: MessageV2.StepStartPart
          part: Extract<MessageV2.Part, { type: "patch" }>
        }[] = []
        for (const name of ["alpha", "beta"]) {
          const branch = path.join(dir, name)
          yield* Effect.promise(async () => {
            const proc = Bun.spawn(["git", "worktree", "add", "--detach", branch], {
              cwd: dir,
              stdout: "ignore",
              stderr: "pipe",
              windowsHide: true,
            })
            const error = await new Response(proc.stderr).text()
            if ((await proc.exited) !== 0) throw new Error(error)
          })
          workers.push(
            yield* Effect.gen(function* () {
              const ctx = yield* InstanceState.context
              const session = yield* sessions.create({ parentID: parent.id })
              const file = path.join(branch, "notes.txt")
              const before = `${name} original\r\n`
              const after = `${name} edited\r\n`
              yield* Effect.promise(() => fs.writeFile(file, before))
              const start = yield* snap.track({ snapshotInitialization: "wait" })
              yield* Effect.promise(() => fs.writeFile(file, after))
              const finish = yield* snap.track({ snapshotInitialization: "wait" })
              if (!start || !finish) throw new Error("Missing worker snapshots")
              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                agent: "default",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const message = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                parentID: user.id,
                role: "assistant",
                agent: "default",
                mode: "default",
                path: { cwd: ctx.directory, root: ctx.worktree },
                cost: 0,
                tokens,
                modelID: ModelV2.ID.make("test"),
                providerID: ProviderV2.ID.make("test"),
                time: { created: Date.now() },
                finish: "end_turn",
              })
              const patch = yield* snap.patch(start, finish)
              const beginning = yield* sessions.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: message.id,
                type: "step-start",
                snapshot: start,
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: message.id,
                type: "step-finish",
                snapshot: finish,
                reason: "stop",
                cost: 0,
                tokens,
              })
              const part = yield* sessions.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: message.id,
                type: "patch",
                ...patch,
              })
              yield* storage.write(["session_diff", session.id], yield* snap.diffFull(start, finish))
              return { session, file, before, after, beginning, part }
            }).pipe(provideInstance(branch)),
          )
        }
        const expected = Object.fromEntries(
          (yield* summary.diff({ sessionID: parent.id })).map((diff) => [diff.file!, revision(diff)]),
        )
        expect(Object.keys(expected)).toHaveLength(2)
        const bytes = () => Effect.promise(() => Promise.all(workers.map((worker) => fs.readFile(worker.file, "utf8"))))
        expect(yield* bytes()).toEqual(workers.map((worker) => worker.after))
        const second = workers[1]
        yield* sessions.updatePart({ ...second.beginning, snapshot: "a".repeat(40) })
        yield* sessions.updatePart({ ...second.part, hash: "a".repeat(40) })
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              revert.discardChanges({ sessionID: parent.id, expected, requestID: "invalid-later-owner" }),
            ),
          ),
        ).toBe(true)
        expect(yield* bytes()).toEqual(workers.map((worker) => worker.after))
        yield* sessions.updatePart(second.beginning)
        yield* sessions.updatePart(second.part)
        yield* Effect.promise(() => fs.writeFile(second.file, "manual beta\r\n"))
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              revert.discardChanges({ sessionID: parent.id, expected, requestID: "stale-later-owner" }),
            ),
          ),
        ).toBe(true)
        expect(yield* bytes()).toEqual([workers[0].after, "manual beta\r\n"])
        yield* Effect.promise(() => fs.writeFile(second.file, second.after))
        yield* revert.discardChanges({ sessionID: parent.id, expected, requestID: "two-owner-undo" })
        expect(yield* bytes()).toEqual(workers.map((worker) => worker.before))
        expect(yield* Effect.promise(() => fs.readFile(own, "utf8"))).toBe("parent untouched\r\n")
        expect(yield* summary.diff({ sessionID: parent.id })).toEqual([])
        yield* revert.discardChanges({ sessionID: parent.id, expected, requestID: "two-owner-undo" })
        expect(yield* bytes()).toEqual(workers.map((worker) => worker.before))
      }),
    { git: true },
  ),
  60_000,
)
