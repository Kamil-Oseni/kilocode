import path from "node:path"
import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { PersonalTodoProposal } from "@/kilocode/personal-todo/proposal"
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

const agent = (name: string, mode: "primary" | "subagent"): Agent.Info => ({
  name,
  mode,
  options: {},
  permission: [],
})
const ItemResult = Schema.Struct({ status: Schema.String, item: PersonalTodo.Info })
const ProposalResult = Schema.Struct({ status: Schema.String, proposal: PersonalTodoProposal.Info })

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
        expect(tool.description).toContain("local date, local time, or timezone is missing or ambiguous")
        expect(tool.description).toContain("exact Unix epoch milliseconds before mutation")
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
  "creates, updates, and clears reminders with exact revisions and durable request replay",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tool = yield* Tool.init(yield* personalTodoTool({ storage }))
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx = context(asks, "reminder-create-once")

        expect(
          Schema.is(tool.parameters)({
            action: "create",
            title: "Invalid reminder",
            reminderAt: Number.POSITIVE_INFINITY,
          }),
        ).toBe(false)
        expect(
          Schema.is(tool.parameters)({
            action: "update",
            id: "todo_11111111-1111-4111-8111-111111111111",
            revision: 1,
            reminderAt: Number.NaN,
          }),
        ).toBe(false)

        const created = yield* tool.execute(
          { action: "create", title: "Call the dentist", dueAt: 4_000, reminderAt: 3_000 },
          ctx,
        )
        const first = Schema.decodeUnknownSync(ItemResult)(JSON.parse(created.output))
        expect(first.item).toMatchObject({ revision: 1, dueAt: 4_000, reminderAt: 3_000, reminderRevision: 1 })

        const replay = yield* tool.execute(
          { reminderAt: 3_000, dueAt: 4_000, title: "Call the dentist", action: "create" },
          ctx,
        )
        expect(replay).toEqual(created)
        expect(asks).toHaveLength(1)

        const updated = yield* tool.execute(
          { action: "update", id: first.item.id, revision: 1, reminderAt: 3_500 },
          ctx,
        )
        const second = Schema.decodeUnknownSync(ItemResult)(JSON.parse(updated.output))
        expect(second.item).toMatchObject({ revision: 2, reminderAt: 3_500, reminderRevision: 2 })

        const stale = yield* tool.execute({ action: "update", id: first.item.id, revision: 1, reminderAt: null }, ctx)
        expect(JSON.parse(stale.output)).toMatchObject({
          status: "conflict",
          expectedRevision: 1,
          actualRevision: 2,
          latest: { reminderAt: 3_500, reminderRevision: 2, revision: 2 },
        })

        const cleared = yield* tool.execute({ action: "update", id: first.item.id, revision: 2, reminderAt: null }, ctx)
        const third = Schema.decodeUnknownSync(ItemResult)(JSON.parse(cleared.output))
        expect(third.item).toMatchObject({ revision: 3, dueAt: 4_000 })
        expect(third.item.reminderAt).toBeUndefined()
        expect(third.item.reminderRevision).toBeUndefined()
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

it.live(
  "stamps, reviews, and applies proposals without accepting model-generated identities",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tool = yield* Tool.init(yield* personalTodoTool({ storage }))
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx = context(asks, "proposal-call")
        const params = {
          action: "propose" as const,
          target: { kind: "new" as const },
          changes: {
            title: "Plan the move",
            priority: "high" as const,
            subtasks: [
              { kind: "new" as const, title: "Choose an area" },
              { kind: "new" as const, title: "Book viewings" },
            ],
          },
        }

        const proposed = yield* tool.execute(params, ctx)
        const body = Schema.decodeUnknownSync(ProposalResult)(JSON.parse(proposed.output))
        expect(proposed.metadata).toMatchObject({
          action: "propose",
          status: "complete",
          proposalID: body.proposal.id,
          digest: body.proposal.digest,
          view: "personal-todo-proposal",
        })
        expect(body.proposal.source).toEqual({
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: "proposal-call",
        })
        expect(body.proposal.id).toMatch(/^proposal_/)
        expect(body.proposal.target.todoID).toMatch(/^todo_/)
        expect(body.proposal.changes.subtasks?.map((item) => item.id)).toEqual([
          expect.stringMatching(/^subtodo_/),
          expect.stringMatching(/^subtodo_/),
        ])
        expect(yield* PersonalTodo.make({ storage }).list()).toEqual([])
        expect(asks).toEqual([])

        expect(yield* tool.execute(params, ctx)).toEqual(proposed)
        const changed = yield* tool.execute({ ...params, changes: { ...params.changes, title: "Different plan" } }, ctx)
        expect(changed.metadata).toMatchObject({
          action: "propose",
          status: "conflict",
          view: "personal-todo-proposal",
        })
        expect(yield* PersonalTodo.make({ storage }).list()).toEqual([])

        const applied = yield* tool.execute(
          { action: "apply_proposal", proposalID: body.proposal.id, digest: body.proposal.digest },
          ctx,
        )
        expect(applied.metadata).toMatchObject({
          action: "apply_proposal",
          status: "complete",
          proposalID: body.proposal.id,
          digest: body.proposal.digest,
          view: "personal-todo-proposal",
        })
        expect(JSON.parse(applied.output)).toMatchObject({
          status: "complete",
          item: { id: body.proposal.target.todoID, title: "Plan the move", revision: 1 },
        })
        expect(asks.map((request) => request.permission)).toEqual(["personal_todo"])
        expect(asks[0]?.patterns).toEqual(["apply_proposal"])

        const replay = yield* tool.execute(
          { action: "apply_proposal", proposalID: body.proposal.id, digest: body.proposal.digest },
          ctx,
        )
        expect(replay).toEqual(applied)
        expect((yield* PersonalTodo.make({ storage }).get(body.proposal.target.todoID))?.revision).toBe(1)

        const digest = yield* tool.execute(
          { action: "apply_proposal", proposalID: body.proposal.id, digest: "0".repeat(64) },
          ctx,
        )
        expect(digest.metadata).toMatchObject({
          action: "apply_proposal",
          status: "conflict",
          view: "personal-todo-proposal",
        })
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(directory, "storage")))),
    ),
  30_000,
)

it.live(
  "returns a structured stale conflict when an existing proposal base changes before apply",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const todos = PersonalTodo.make({ storage })
        const item = yield* todos.create({ title: "Original" })
        const tool = yield* Tool.init(yield* personalTodoTool({ storage }))
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx = context(asks, "existing-proposal")
        const proposed = yield* tool.execute(
          {
            action: "propose",
            target: { kind: "existing", id: item.id, revision: item.revision },
            changes: { title: "Proposed" },
          },
          ctx,
        )
        const body = Schema.decodeUnknownSync(ProposalResult)(JSON.parse(proposed.output))
        yield* todos.update(item.id, { revision: item.revision, title: "Manual edit" })

        const stale = yield* tool.execute(
          { action: "apply_proposal", proposalID: body.proposal.id, digest: body.proposal.digest },
          ctx,
        )
        expect(stale.metadata).toMatchObject({
          action: "apply_proposal",
          status: "conflict",
          id: item.id,
          expectedRevision: 1,
          actualRevision: 2,
          view: "personal-todo-proposal",
        })
        expect(JSON.parse(stale.output)).toMatchObject({
          status: "conflict",
          expectedRevision: 1,
          actualRevision: 2,
        })
        expect(yield* todos.get(item.id)).toMatchObject({ title: "Manual edit", revision: 2 })
        expect(asks.map((request) => request.patterns)).toEqual([["apply_proposal"]])
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(directory, "storage")))),
    ),
  30_000,
)
