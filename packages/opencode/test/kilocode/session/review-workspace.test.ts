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
import { MessageID, PartID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import * as Project from "@/project/project"
import { detail, overlay } from "@/kilocode/session/review-diff"
import { reviewed } from "@/kilocode/session/review-state"
import { identity, resolve, run, same } from "@/kilocode/session/review-workspace"
import { provideInstance, provideTmpdirProject } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const env = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    Snapshot.node,
    Storage.node,
    Database.node,
    CrossSpawnSpawner.node,
    Project.node,
  ]),
)
const it = testEffect(env)
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

it.live(
  "projects isolated worker edits and details without aliasing parent paths",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const snap = yield* Snapshot.Service
        const storage = yield* Storage.Service
        const parent = yield* sessions.create({})
        const branch = path.join(dir, "branch")
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
        const save = Effect.fn("ReviewWorkspaceTest.save")(function* (
          session: Session.Info,
          file: string,
          before: string,
          after: string,
        ) {
          const ctx = yield* InstanceState.context
          yield* Effect.promise(() => fs.writeFile(file, before))
          const start = yield* snap.track({ snapshotInitialization: "wait" })
          yield* Effect.promise(() => fs.writeFile(file, after))
          const finish = yield* snap.track({ snapshotInitialization: "wait" })
          if (!start || !finish) throw new Error("Missing snapshots")
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
          yield* sessions.updatePart({
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
          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: message.id,
            type: "patch",
            ...patch,
          })
          return message
        })
        const own = path.join(dir, "notes.txt")
        yield* save(parent, own, "parent original", "parent edited")
        const child = yield* Effect.gen(function* () {
          const session = yield* sessions.create({ parentID: parent.id })
          yield* save(session, path.join(branch, "notes.txt"), "child original", "child edited")
          return session
        }).pipe(provideInstance(branch))
        const diffs = yield* overlay(snap, storage, sessions, parent.id, [])
        expect(diffs).toHaveLength(2)
        expect(diffs.find((diff) => diff.file === "notes.txt")?.patch).toContain("parent edited")
        const foreign = path.join(branch, "notes.txt")
        expect(diffs.find((diff) => diff.file === foreign)?.patch).toContain("child edited")
        const full = yield* detail(snap, storage, sessions, parent.id, foreign)
        expect(full.diff?.before).toBe("child original")
        expect(full.diff?.after).toBe("child edited")
        expect(full.diff?.file).toBe(foreign)
        const generations = yield* reviewed(snap, storage, sessions, parent.id, diffs)
        expect(generations.every((diff) => !!diff.generation)).toBe(true)
        expect(new Set(generations.map((diff) => diff.generation)).size).toBe(2)

        const subdir = path.join(branch, "subdir")
        yield* Effect.promise(() => fs.mkdir(subdir))
        const nested = yield* Effect.gen(function* () {
          const session = yield* sessions.create({ parentID: parent.id })
          yield* save(session, path.join(subdir, "nested.txt"), "nested original", "nested edited")
          return session
        }).pipe(provideInstance(subdir))
        const nestedfile = path.join(subdir, "nested.txt")
        const nestedfull = yield* detail(snap, storage, sessions, parent.id, nestedfile)
        expect(nestedfull.diff?.before).toBe("nested original")
        expect(nestedfull.diff?.after).toBe("nested edited")
        const owner = yield* resolve(sessions, nested.id, yield* sessions.messages({ sessionID: nested.id }))
        expect(owner.root).toBe(branch)
        expect(owner.directory).toBe(subdir)
        expect(same(identity(owner), identity(yield* resolve(sessions, nested.id)))).toBe(true)
        expect(same(identity(owner), { ...identity(owner), cwdIno: `${owner.cwdIno}1` })).toBe(false)

        yield* Effect.promise(() => fs.rename(subdir, path.join(branch, "retained")))
        expect(Exit.isFailure(yield* Effect.exit(resolve(sessions, nested.id)))).toBe(true)
        yield* Effect.promise(() => fs.mkdir(subdir))
        expect(Exit.isFailure(yield* Effect.exit(run(owner, Effect.succeed("must not execute"))))).toBe(true)
        const messages = yield* sessions.messages({ sessionID: child.id })
        const changed = messages.map((message) =>
          message.info.role === "assistant"
            ? { ...message, info: { ...message.info, path: { cwd: branch, root: dir } } }
            : message,
        )
        expect(Exit.isFailure(yield* Effect.exit(resolve(sessions, child.id, changed)))).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(own, "utf8"))).toBe("parent edited")
        expect(yield* Effect.promise(() => fs.readFile(foreign, "utf8"))).toBe("child edited")
      }),
    { git: true },
  ),
  120_000,
)
