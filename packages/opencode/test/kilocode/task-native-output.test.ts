import { afterAll, expect } from "bun:test"
import path from "node:path"
import os from "node:os"
import { realpath } from "node:fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Instruction } from "@/session/instruction"
import { Storage } from "@/storage/storage"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { WriteTool } from "@/tool/write"
import { EditTool } from "@/tool/edit"
import { ReadTool } from "@/tool/read"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { remove } from "./cleanup"

const root = path.join(os.tmpdir(), `raya-native-outputs-${process.pid}-${crypto.randomUUID()}`)
const db = `${root}.sqlite`
const marker = `${root}.formatter`
const server = `${root}.lsp`
const database = Database.layerFromPath(db)
const files = LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))
const app = AppNodeBuilder.build(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    Storage.node,
    Database.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Agent.node,
    EventV2Bridge.node,
    Format.node,
    LSP.node,
    Instruction.node,
    Truncate.node,
  ]),
  [
    [Database.node, database],
    [Storage.node, Storage.layerWithDatabase(root).pipe(Layer.provide(database), Layer.provide(files))],
  ],
)
const it = testEffect(app)
afterAll(async () => {
  await Promise.all([root, db, `${db}-wal`, `${db}-shm`, marker, server].map(remove))
}, 30_000)

it.instance(
  "native file tools enforce genuine delegated output scopes and preserve other stages",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = yield* Effect.promise(() => realpath(instance.directory))
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const tasks = RayaTask.make({ storage, database })
      const execution = RayaTaskExecution.make(storage)
      const write = yield* (yield* WriteTool).init()
      const edit = yield* (yield* EditTool).init()
      const read = yield* (yield* ReadTool).init()
      const patch = yield* (yield* ApplyPatchTool).init()
      const own = path.join(dir, "own.txt")
      const other = path.join(dir, "other.txt")
      const moved = path.join(dir, "moved.txt")
      expect(yield* (yield* Format.Service).available(own)).toBe(true)
      yield* Effect.promise(() => Bun.write(other, "Other stage unchanged\n"))
      const bind = Effect.fn(function* (outputs: string[]) {
        const agent = yield* tasks.create({
          name: "Native output worker",
          objective: "Change only declared files",
          schedule: { kind: "manual" },
          access: "brief",
          dir,
        })
        const id = crypto.randomUUID()
        const delegation = `dlg_${crypto.randomUUID()}`
        const chat = yield* sessions.create({
          metadata: {
            private: true,
            capture: false,
            rayaRoutine: {
              version: 2,
              agentID: agent.id,
              runID: id,
              scheduleVersion: agent.scheduleVersion ?? 1,
              trigger: { kind: "manual" },
              delegationID: delegation,
              outputs,
            },
          },
        })
        const run = yield* tasks.record({
          id,
          agentID: agent.id,
          sessionID: chat.id,
          at: Date.now(),
          status: "running",
        })
        yield* RayaTaskSnapshot.make({ storage }).save({
          version: 2,
          runID: id,
          agentID: agent.id,
          sessionID: chat.id,
          at: run.at,
          definition: agent,
          objective: agent.objective,
          outputs,
        })
        yield* database.db
          .insert(Delegation)
          .values({
            id: delegation,
            source: delegation,
            sender_id: agent.id,
            recipient_id: agent.id,
            objective: agent.objective,
            depth: 1,
            state: "running",
            outputs: JSON.stringify(outputs),
            child_run_id: run.id,
            session_id: chat.id,
            time_created: run.at,
            time_updated: run.at,
          })
          .run()
          .pipe(Effect.orDie)
        return {
          run,
          ctx: () => ({
            sessionID: chat.id,
            messageID: MessageID.ascending(),
            callID: crypto.randomUUID(),
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }),
        }
      })
      const first = yield* bind([own])
      yield* execution.enter(
        first.run,
        Effect.gen(function* () {
          yield* write.execute({ filePath: own, content: "Original\n" }, first.ctx())
          expect(yield* Effect.promise(() => Bun.file(own).text())).toBe("Original\n")
          expect((yield* read.execute({ filePath: own }, first.ctx())).output).toContain("Original")
          yield* edit.execute({ filePath: own, oldString: "Original", newString: "Edited" }, first.ctx())
          expect(yield* Effect.promise(() => Bun.file(own).text())).toBe("Edited\n")
          yield* patch.execute(
            { patchText: `*** Begin Patch\n*** Update File: ${own}\n@@\n-Edited\n+Patched\n*** End Patch` },
            first.ctx(),
          )
          expect(yield* Effect.promise(() => Bun.file(own).text())).toBe("Patched\n")
          for (const effect of [
            write.execute({ filePath: other, content: "Forbidden" }, first.ctx()),
            edit.execute({ filePath: other, oldString: "Other", newString: "Forbidden" }, first.ctx()),
            patch.execute(
              {
                patchText: `*** Begin Patch\n*** Update File: ${other}\n@@\n-Other stage unchanged\n+Forbidden\n*** End Patch`,
              },
              first.ctx(),
            ),
            patch.execute(
              {
                patchText: `*** Begin Patch\n*** Update File: ${own}\n*** Move to: ${moved}\n@@\n-Patched\n+Moved\n*** End Patch`,
              },
              first.ctx(),
            ),
          ]) {
            const result = yield* effect.pipe(Effect.exit)
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result))
              expect(Cause.pretty(result.cause)).toContain("outside this worker's declared outputs")
            expect(yield* Effect.promise(() => Bun.file(other).text())).toBe("Other stage unchanged\n")
            expect(yield* Effect.promise(() => Bun.file(own).text())).toBe("Patched\n")
            expect(yield* Effect.promise(() => Bun.file(moved).exists())).toBe(false)
          }
        }),
      )
      yield* execution.finish(first.run)
      const readonly = yield* bind([])
      yield* execution.enter(
        readonly.run,
        Effect.gen(function* () {
          expect((yield* read.execute({ filePath: other }, readonly.ctx())).output).toContain("Other stage unchanged")
          const result = yield* write.execute({ filePath: own, content: "Forbidden" }, readonly.ctx()).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain("outside this worker's declared outputs")
          expect(yield* Effect.promise(() => Bun.file(own).text())).toBe("Patched\n")
        }),
      )
      yield* execution.finish(readonly.run)
      const moving = yield* bind([own, moved])
      yield* execution.enter(
        moving.run,
        patch.execute(
          {
            patchText: `*** Begin Patch\n*** Update File: ${own}\n*** Move to: ${moved}\n@@\n-Patched\n+Moved\n*** End Patch`,
          },
          moving.ctx(),
        ),
      )
      expect(yield* Effect.promise(() => Bun.file(own).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(moved).text())).toBe("Moved\n")
      expect(yield* Effect.promise(() => Bun.file(other).text())).toBe("Other stage unchanged\n")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(server).exists())).toBe(false)
      yield* execution.finish(moving.run)
      const revoked = yield* bind([moved])
      yield* execution.enter(
        revoked.run,
        Effect.gen(function* () {
          const result = yield* write
            .execute(
              { filePath: moved, content: "Forbidden after approval" },
              {
                ...revoked.ctx(),
                ask: () =>
                  sessions.setMetadata({
                    sessionID: revoked.run.sessionID,
                    metadata: { private: true, capture: false },
                  }),
              },
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("lost its output-scope identity")
          expect(yield* Effect.promise(() => Bun.file(moved).text())).toBe("Moved\n")
        }),
      )
      yield* execution.finish(revoked.run)
    }),
  {
    config: {
      lsp: {
        scoped: {
          extensions: [".txt"],
          command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(server)}, 'unexpected')`],
        },
      },
      formatter: {
        scoped: {
          extensions: [".txt"],
          command: [
            process.execPath,
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`,
            "$FILE",
          ],
        },
      },
    },
  },
  30_000,
)
