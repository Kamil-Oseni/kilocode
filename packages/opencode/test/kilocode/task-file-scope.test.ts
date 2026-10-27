import { afterAll, afterEach, expect } from "bun:test"
import { mkdir, rename, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import type * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import * as TaskFiles from "@/kilocode/tool/task-files"
import * as Producer from "@/kilocode/tool/task-files-producer"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { Permission } from "@/permission"
import { ChiefPlan } from "@/kilocode/chief/plan"
import * as Admission from "@/kilocode/task/output-admission"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { remove } from "./cleanup"

const db = path.join(os.tmpdir(), `raya-task-files-${process.pid}-${crypto.randomUUID()}.sqlite`)
afterAll(async () => {
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map(remove))
}, 30_000)
afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Session.node,
      SessionProjector.node,
      Storage.node,
      FSUtil.node,
      InstanceStore.node,
      LSP.node,
      Format.node,
      EventV2Bridge.node,
      Truncate.node,
      Agent.node,
      Git.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
    ]),
    [
      [Database.node, Database.layerFromPath(db)],
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const denied = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
  Effect.gen(function* () {
    const result = yield* effect.pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(message)
  })

const seed = Effect.fn("TaskFilesTest.seed")(function* (files?: TaskFiles.Declared) {
  const instance = yield* TestInstance
  const sessions = yield* Session.Service
  const storage = yield* Storage.Service
  const fs = yield* FSUtil.Service
  const parent = yield* sessions.create({ title: "File assignment owner" })
  const prepared = yield* Producer.prepare({
    auto: files !== undefined,
    access: files === undefined ? undefined : "edit",
    files,
    storage,
    fs,
  })
  const allocated = yield* Producer.allocate(prepared, instance.directory, parent.id)
  const binding = allocated?.files
  if (allocated) {
    expect(Exit.isFailure(yield* sessions.get(allocated.id).pipe(Effect.exit))).toBe(true)
    expect(yield* TaskFiles.find(storage, allocated.id)).toEqual(binding)
  }
  const metadata = { ...TaskAuthority.save({}, "edit"), ...(binding ? { [TaskFiles.key]: binding } : {}) }
  const child = yield* sessions.create({
    id: allocated?.id,
    parentID: parent.id,
    title: "Exact files worker",
    metadata,
  })
  expect((yield* sessions.get(child.id)).metadata).toEqual(metadata)
  const ctx: Tool.Context = {
    sessionID: child.id,
    messageID: MessageID.make("msg_task_files"),
    callID: "task-files",
    agent: "code",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
  return { instance, sessions, storage, fs, parent, child, binding, metadata, ctx }
})

it.instance(
  "native Write, Edit and Patch constrain both move endpoints to actual producer-bound files",
  () =>
    Effect.gen(function* () {
      const state = yield* seed(["owned.txt", "moved.txt"])
      const owned = path.join(state.instance.directory, "owned.txt")
      const moved = path.join(state.instance.directory, "moved.txt")
      const foreign = path.join(state.instance.directory, "foreign.txt")
      yield* state.fs.writeFileString(foreign, "keep\n")
      const write = yield* (yield* WriteTool).init()
      const edit = yield* (yield* EditTool).init()
      const patch = yield* (yield* ApplyPatchTool).init()
      yield* write.execute({ filePath: owned, content: "first\n" }, state.ctx)
      yield* edit.execute({ filePath: owned, oldString: "first", newString: "second" }, state.ctx)
      expect(yield* state.fs.readFileString(owned)).toBe("second\n")
      yield* denied(write.execute({ filePath: foreign, content: "overwrite" }, state.ctx), "declared files")
      yield* denied(
        edit.execute({ filePath: foreign, oldString: "keep", newString: "overwrite" }, state.ctx),
        "declared files",
      )
      yield* denied(
        patch.execute(
          {
            patchText:
              "*** Begin Patch\n*** Update File: owned.txt\n*** Move to: outside.txt\n@@\n-second\n+third\n*** End Patch",
          },
          { ...state.ctx, callID: "patch-foreign-destination" },
        ),
        "declared files",
      )
      yield* denied(
        patch.execute(
          {
            patchText:
              "*** Begin Patch\n*** Update File: foreign.txt\n*** Move to: moved.txt\n@@\n-keep\n+third\n*** End Patch",
          },
          { ...state.ctx, callID: "patch-foreign-source" },
        ),
        "declared files",
      )
      expect(yield* state.fs.readFileString(foreign)).toBe("keep\n")
      expect(yield* state.fs.readFileString(owned)).toBe("second\n")
      expect(yield* state.fs.exists(moved)).toBe(false)
      expect(yield* state.fs.exists(path.join(state.instance.directory, "outside.txt"))).toBe(false)
      yield* patch.execute(
        {
          patchText:
            "*** Begin Patch\n*** Update File: owned.txt\n*** Move to: moved.txt\n@@\n-second\n+third\n*** End Patch",
        },
        { ...state.ctx, callID: "patch-owned-move" },
      )
      expect(yield* state.fs.exists(owned)).toBe(false)
      expect(yield* state.fs.readFileString(moved)).toBe("third\n")
    }),
  30_000,
)

it.instance(
  "immutable reopened scopes refuse widening and missing metadata while empty and legacy scopes stay distinct",
  () =>
    Effect.gen(function* () {
      const state = yield* seed(["owned.txt"])
      if (!state.binding) throw new Error("The producer must bind an explicit declaration")
      const binding = state.binding
      const root = path.join(state.instance.directory, "private-storage")
      const database = yield* Database.Service
      const git = yield* Git.Service
      const reopened = () =>
        Storage.layerWithDatabase(root).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Database.Service, database),
              Layer.succeed(FSUtil.Service, state.fs),
              Layer.succeed(Git.Service, git),
            ),
          ),
        )
      const input = {
        session: state.child.id,
        parent: state.parent.id,
        directory: state.instance.directory,
        files: binding.declared,
        fs: state.fs,
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.Service
          expect(yield* TaskFiles.bind({ ...input, storage })).toEqual(binding)
          expect(yield* TaskFiles.bind({ ...input, storage })).toEqual(binding)
        }).pipe(Effect.provide(reopened())),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.Service
          expect(yield* TaskFiles.find(storage, state.child.id)).toEqual(binding)
          const write = yield* (yield* WriteTool).init()
          yield* write.execute({ filePath: binding.canonical[0]!, content: "after reopen\n" }, state.ctx)
          expect(yield* state.fs.readFileString(binding.canonical[0]!)).toBe("after reopen\n")
          yield* denied(TaskFiles.bind({ ...input, storage, files: ["owned.txt", "other.txt"] }), "cannot be replaced")
          expect(
            yield* TaskFiles.check(
              {
                id: state.child.id,
                parentID: state.parent.id,
                directory: state.instance.directory,
                metadata: state.metadata,
              },
              binding.canonical,
            ),
          ).toEqual(binding.canonical)
          yield* denied(
            TaskFiles.check(
              { id: state.child.id, parentID: state.parent.id, directory: state.instance.directory },
              binding.canonical,
            ),
            "no longer matches",
          )
          yield* denied(
            Producer.prepare({ auto: true, access: "edit", resumed: { id: state.child.id }, storage, fs: state.fs }),
            "lost or changed",
          )
          yield* denied(
            Producer.prepare({
              auto: true,
              access: "edit",
              resumed: { id: state.child.id, metadata: state.metadata },
              files: ["other.txt"],
              storage,
              fs: state.fs,
            }),
            "cannot be changed",
          )
          expect(
            (yield* Producer.prepare({
              auto: true,
              access: "edit",
              resumed: { id: state.child.id, metadata: state.metadata },
              storage,
              fs: state.fs,
            }))?.files,
          ).toEqual(binding.declared)
        }).pipe(Effect.provide(reopened())),
      )
      yield* Effect.promise(() =>
        Effect.runPromise(
          denied(Admission.check(state.child.id, binding.canonical), "assigned file-scope session is unavailable").pipe(
            Effect.provide(reopened()),
          ),
        ),
      )
      for (const tool of ["bash", "task", "delegate_work", "remote_tool"]) {
        expect(TaskFiles.permits(state.metadata, tool)).toBe(false)
        expect(Permission.evaluate(tool, "anything", TaskAuthority.hard(state.metadata, tool, ["*"])).action).toBe(
          "deny",
        )
      }
      const keys = yield* state.storage.list(["raya", "task-files"])
      const children = yield* state.sessions.children(state.child.id)
      yield* denied(
        Producer.prepare({
          auto: false,
          access: "edit",
          files: ["owned.txt"],
          parent: yield* state.sessions.get(state.child.id),
          storage: state.storage,
          fs: state.fs,
        }).pipe(
          Effect.flatMap((prepared) => Producer.allocate(prepared, state.instance.directory, state.child.id)),
          Effect.flatMap((allocated) =>
            state.sessions.create({
              id: allocated?.id,
              parentID: state.child.id,
              title: "Forbidden nested worker",
              metadata: allocated ? { [TaskFiles.key]: allocated.files } : {},
            }),
          ),
        ),
        "file-scoped Task cannot delegate",
      )
      expect(yield* state.storage.list(["raya", "task-files"])).toEqual(keys)
      expect(yield* state.sessions.children(state.child.id)).toEqual(children)
      const write = yield* (yield* WriteTool).init()
      yield* state.sessions.setMetadata({ sessionID: state.child.id, metadata: TaskAuthority.save({}, "edit") })
      yield* denied(
        write.execute({ filePath: binding.canonical[0]!, content: "lost marker" }, state.ctx),
        "no longer matches",
      )
      expect(yield* state.fs.readFileString(binding.canonical[0]!)).toBe("after reopen\n")
      const empty = yield* seed([])
      yield* denied(
        write.execute({ filePath: path.join(state.instance.directory, "empty.txt"), content: "no" }, empty.ctx),
        "declared files",
      )
      const legacy = yield* seed()
      const file = path.join(state.instance.directory, "legacy.txt")
      yield* write.execute({ filePath: file, content: "legacy" }, legacy.ctx)
      expect(yield* state.fs.readFileString(file)).toBe("legacy")
      yield* denied(
        Producer.prepare({ auto: true, access: "edit", storage: state.storage, fs: state.fs }),
        "needs files",
      )
      yield* state.sessions.remove(state.child.id)
      expect(yield* TaskFiles.find(state.storage, state.child.id)).toBeUndefined()
      expect(yield* state.fs.readFileString(binding.canonical[0]!)).toBe("after reopen\n")
    }),
  30_000,
)

it.instance(
  "retargeted directory aliases cannot redirect a saved native file assignment",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const slot = path.join(instance.directory, "slot")
      const other = path.join(instance.directory, "other")
      yield* Effect.promise(() => mkdir(slot))
      yield* Effect.promise(() => mkdir(other))
      const state = yield* seed(["slot/owned.txt"])
      const foreign = path.join(other, "owned.txt")
      yield* state.fs.writeFileString(foreign, "foreign unchanged")
      yield* Effect.promise(() => rename(slot, path.join(instance.directory, "retired")))
      yield* Effect.promise(() => symlink(other, slot, process.platform === "win32" ? "junction" : "dir"))
      const write = yield* (yield* WriteTool).init()
      yield* denied(write.execute({ filePath: path.join(slot, "owned.txt"), content: "overwrite" }, state.ctx), "alias")
      expect(yield* state.fs.readFileString(foreign)).toBe("foreign unchanged")
      yield* denied(
        Producer.prepare({
          auto: true,
          access: "edit",
          files: ["../outside.txt"],
          storage: state.storage,
          fs: state.fs,
        }).pipe(
          Effect.flatMap((prepared) =>
            Producer.bind(prepared, { id: `${state.child.id}-bad`, directory: instance.directory }, state.parent.id),
          ),
        ),
        "exact relative",
      )
      for (const files of [["/absolute.txt"], ["../parent.txt"], ["slot/*.txt"], ["NUL.txt"], ["same.txt", "same.txt"]])
        expect(Schema.is(TaskFiles.Declared)(files)).toBe(false)
      const proposals = ["page", "report"].map((id) => ({
        id,
        name: id,
        specialist: "coder",
        access: "edit" as const,
        brief: { objective: `Change ${id}`, constraints: ["Preserve other files"], expectedReturn: `${id} result` },
        files: [`${id}.txt`],
        scope: [id],
        dependsOn: [],
        independence: "Separate exact file",
        authority: "Existing edit permission",
      }))
      const plan = (items: unknown) =>
        ChiefPlan.validate({
          request: "Update the independent page and report files",
          proposals: items,
          agents: [{ name: "coder", mode: "subagent" }],
          parent: Permission.fromConfig({ task: "allow", edit: "allow" }),
        })
      expect(plan(proposals).map((item) => item.files)).toEqual([["page.txt"], ["report.txt"]])
      expect(() => plan([{ ...proposals[0], files: undefined }, proposals[1]])).toThrow()
      expect(() => plan([proposals[0], { ...proposals[1], files: ["page.txt"] }])).toThrow("overlaps")
    }),
  30_000,
)
