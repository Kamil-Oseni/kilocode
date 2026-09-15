import path from "node:path"
import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { personalTodoTool } from "@/kilocode/tool/personal-todo"
import { KiloToolRegistry } from "@/kilocode/tool/registry"
import * as Permission from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(Agent.node),
    AppNodeBuilder.build(Permission.node),
    AppNodeBuilder.build(Truncate.node),
    AppNodeBuilder.build(CrossSpawnSpawner.node),
    AppNodeBuilder.build(FSUtil.node),
    AppNodeBuilder.build(Git.node),
  ),
)

const agent = (name: string, mode: "primary" | "subagent") =>
  Schema.decodeUnknownSync(Agent.Info)({ name, mode, options: {}, permission: [] })
const ItemResult = Schema.Struct({ status: Schema.String, item: PersonalTodo.Info })

function context(asks: Parameters<Tool.Context["ask"]>[0][], callID?: string): Tool.Context {
  return {
    sessionID: SessionID.make("ses_personal_todo_tool"),
    messageID: MessageID.make("msg_personal_todo_tool"),
    callID,
    agent: "code",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) => Effect.sync(() => asks.push(request)),
  }
}

it.live(
  "executes the complete personal Todo lifecycle against durable storage with revision conflicts",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const info = yield* personalTodoTool({ storage })
        const tool = yield* Tool.init(info)
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx = context(asks, "create-once")

        expect(tool.description).toContain("ask_options")
        expect(tool.description).toContain("one reviewed item per call")
        expect(KiloToolRegistry.available(tool, agent("code", "primary"))).toBe(true)
        expect(KiloToolRegistry.available(tool, agent("worker", "subagent"))).toBe(true)
        expect(
          KiloToolRegistry.extra(
            {
              recall: tool,
              managerModels: tool,
              memory: tool,
              save: tool,
              manager: tool,
              process: tool,
              chart: tool,
              image: tool,
              notify: tool,
              send: tool,
              personalTodo: tool,
            },
            {},
          ),
        ).toContain(tool)

        const created = yield* tool.execute({ action: "create", title: "Rent a house", detail: "Review options" }, ctx)
        const first = Schema.decodeUnknownSync(ItemResult)(JSON.parse(created.output))
        expect(first).toMatchObject({ status: "complete", item: { title: "Rent a house", done: false, revision: 1 } })
        expect(asks.map((request) => request.permission)).toEqual(["personal_todo"])
        expect(asks[0]?.patterns).toEqual(["create"])

        const replay = yield* tool.execute({ detail: "Review options", action: "create", title: "Rent a house" }, ctx)
        expect(replay).toEqual(created)
        expect(asks).toHaveLength(1)
        const changed = yield* tool.execute({ action: "create", title: "Different Todo" }, ctx)
        expect(changed).toMatchObject({
          title: "Personal Todo request needs review",
          metadata: { requestStatus: "unresolved", action: "create", status: "invalid" },
        })
        expect(changed.output).toContain("different Todo instructions")
        expect(asks).toHaveLength(1)

        const listed = yield* tool.execute({ action: "list" }, ctx)
        expect(JSON.parse(listed.output)).toMatchObject({ items: [{ id: first.item.id, revision: 1 }] })
        expect(asks).toHaveLength(1)

        const updated = yield* tool.execute(
          { action: "update", id: first.item.id, revision: 1, title: "Rent a Toronto house", dueAt: 2_000 },
          ctx,
        )
        const second = Schema.decodeUnknownSync(ItemResult)(JSON.parse(updated.output))
        expect(second.item).toMatchObject({ revision: 2, title: "Rent a Toronto house", dueAt: 2_000 })

        const stale = yield* tool.execute(
          { action: "update", id: first.item.id, revision: 1, title: "Overwrite current title" },
          ctx,
        )
        expect(stale.metadata).toMatchObject({
          action: "update",
          status: "conflict",
          id: first.item.id,
          expectedRevision: 1,
          actualRevision: 2,
          revision: 2,
        })
        expect(JSON.parse(stale.output)).toMatchObject({
          status: "conflict",
          expectedRevision: 1,
          actualRevision: 2,
          latest: { id: first.item.id, title: "Rent a Toronto house", revision: 2 },
        })

        const completed = yield* tool.execute({ action: "complete", id: first.item.id, revision: 2 }, ctx)
        expect(JSON.parse(completed.output)).toMatchObject({ item: { done: true, revision: 3 } })
        const reopened = yield* tool.execute({ action: "reopen", id: first.item.id, revision: 3 }, ctx)
        expect(JSON.parse(reopened.output)).toMatchObject({ item: { done: false, revision: 4 } })

        const staleDelete = yield* tool.execute({ action: "delete", id: first.item.id, revision: 2 }, ctx)
        expect(JSON.parse(staleDelete.output)).toMatchObject({
          status: "conflict",
          operation: "delete",
          expectedRevision: 2,
          actualRevision: 4,
          latest: { id: first.item.id, done: false, revision: 4 },
        })
        expect(yield* storage.list(["raya", "personal-todos", "v1"])).toHaveLength(1)

        const removed = yield* tool.execute({ action: "delete", id: first.item.id, revision: 4 }, ctx)
        expect(JSON.parse(removed.output)).toEqual({ status: "complete", id: first.item.id, deleted: true })
        expect((yield* tool.execute({ action: "get", id: first.item.id }, ctx)).metadata.status).toBe("missing")
        expect(JSON.parse((yield* tool.execute({ action: "list" }, ctx)).output)).toEqual({
          status: "complete",
          items: [],
        })
        expect(asks.map((request) => request.patterns)).toEqual([
          ["create"],
          ["update"],
          ["update"],
          ["complete"],
          ["reopen"],
          ["delete"],
          ["delete"],
        ])
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(directory, "storage")))),
    ),
  30_000,
)

it.live(
  "keeps an uncertain create receipt after acknowledgement loss and never creates a replacement",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const failed = { value: false }
        const unreliable = {
          ...storage,
          replace: (key: string[], value: unknown) =>
            key[0] === "raya" && key[1] === "agent-requests" && !failed.value
              ? Effect.sync(() => {
                  failed.value = true
                  throw new Error("simulated Todo acknowledgement loss")
                })
              : storage.replace(key, value),
        }
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx = context(asks, "lost-create-result")
        const broken = yield* Tool.init(yield* personalTodoTool({ storage: unreliable }))
        const lost = yield* broken.execute({ action: "create", title: "Keep exactly one" }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(lost)).toBe(true)

        const tool = yield* Tool.init(yield* personalTodoTool({ storage }))
        const retry = yield* tool.execute({ action: "create", title: "Keep exactly one" }, ctx)
        expect(retry).toMatchObject({
          title: "Personal Todo request needs review",
          metadata: { requestStatus: "unresolved", action: "create", status: "invalid" },
        })
        expect(retry.output).toContain("may have succeeded")
        expect(asks).toHaveLength(1)
        expect(JSON.parse((yield* tool.execute({ action: "list" }, ctx)).output)).toMatchObject({
          status: "complete",
          items: [{ title: "Keep exactly one", revision: 1 }],
        })
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(directory, "storage")))),
    ),
  30_000,
)
