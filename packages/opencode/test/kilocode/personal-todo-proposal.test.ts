import path from "node:path"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Git } from "@/git"
import { PersonalTodoProposal } from "@/kilocode/personal-todo/proposal"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const id = "proposal_11111111-1111-4111-8111-111111111111"
const other = "proposal_66666666-6666-4666-8666-666666666666"
const third = "proposal_77777777-7777-4777-8777-777777777777"
const todo = "todo_22222222-2222-4222-8222-222222222222"
const sub1 = "subtodo_33333333-3333-4333-8333-333333333333"
const sub2 = "subtodo_44444444-4444-4444-8444-444444444444"
const source = { sessionID: "ses_test", messageID: "msg_test", callID: "call_test" }

it.live("stores immutable proposals idempotently and reconstructs their canonical digest", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const input: PersonalTodoProposal.Input = {
      id,
      source,
      target: { kind: "new", todoID: todo, baseRevision: 0 },
      changes: {
        title: "Plan the move",
        detail: "Start with the lease",
        dueAt: 500,
        reminderAt: 400,
        subtasks: [
          { kind: "new", id: sub1, title: "Choose an area" },
          { kind: "new", id: sub2, title: "Book viewings" },
        ],
      },
    }
    const first = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const proposals = PersonalTodoProposal.make({ storage, now: () => 100 })
      const item = yield* proposals.propose(input)
      expect(yield* proposals.propose(input)).toEqual(item)
      return item
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))

    expect(first.digest).toBe(PersonalTodoProposal.seal(first))
    expect(first.changes.subtasks?.map((item) => item.id)).toEqual([sub1, sub2])

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const proposals = PersonalTodoProposal.make({ storage, now: () => 999 })
      expect(yield* proposals.get(id)).toEqual(first)
      expect(yield* proposals.propose(input)).toEqual(first)
      expect(yield* proposals.list()).toEqual([first])
      const changed = yield* proposals
        .propose({ ...input, changes: { ...input.changes, title: "Changed" } })
        .pipe(Effect.flip)
      expect(changed._tag).toBe("PersonalTodoProposalConflictError")
      expect(yield* proposals.get(id)).toEqual(first)
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("enforces target, change, clear, and ordered subtask bounds", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const proposals = PersonalTodoProposal.make({ storage, now: () => 100 })
      const base = { id, source, target: { kind: "new" as const, todoID: todo, baseRevision: 0 as const } }
      const missing = yield* proposals.propose({ ...base, changes: {} }).pipe(Effect.flip)
      expect(missing._tag).toBe("PersonalTodoProposalInputError")
      const cleared = yield* proposals.propose({ ...base, changes: { title: "New", detail: null } }).pipe(Effect.flip)
      expect(cleared._tag).toBe("PersonalTodoProposalInputError")
      const metadata = yield* proposals
        .propose({ ...base, changes: { title: "New", priority: null, estimateMinutes: null, links: null } })
        .pipe(Effect.flip)
      expect(metadata._tag).toBe("PersonalTodoProposalInputError")
      const impossible = yield* proposals
        .propose({
          ...base,
          changes: { title: "New", subtasks: [{ kind: "existing", id: sub1, revision: 1, title: "Impossible" }] },
        })
        .pipe(Effect.flip)
      expect(impossible._tag).toBe("PersonalTodoProposalInputError")

      const existing = { ...base, target: { kind: "existing" as const, todoID: todo, baseRevision: 1 } }
      const empty = yield* proposals.propose({ ...existing, changes: {} }).pipe(Effect.flip)
      expect(empty._tag).toBe("PersonalTodoProposalInputError")
      const duplicate = yield* proposals
        .propose({
          ...existing,
          changes: {
            subtasks: [
              { kind: "new", id: sub1, title: "One" },
              { kind: "new", id: sub1, title: "Two" },
            ],
          },
        })
        .pipe(Effect.flip)
      expect(duplicate._tag).toBe("PersonalTodoProposalInputError")
      const many = Array.from({ length: 101 }, (_, index) => ({
        kind: "new" as const,
        id: `subtodo_55555555-5555-4555-8555-${index.toString().padStart(12, "0")}`,
        title: `Step ${index}`,
      }))
      const bounded = yield* proposals.propose({ ...existing, changes: { subtasks: many } }).pipe(Effect.flip)
      expect(bounded._tag).toBe("PersonalTodoProposalInputError")
      const clear = yield* proposals.propose({
        ...existing,
        changes: { detail: null, dueAt: null, reminderAt: null },
      })
      expect(clear.changes).toEqual({ detail: null, dueAt: null, reminderAt: null })
      expect(clear.digest).toBe(PersonalTodoProposal.seal(clear))
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("rejects malformed, miskeyed, and digest-corrupt stored proposals", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.write(["raya", "personal-todo-proposals", "v1", id], {
        version: 1,
        id,
        digest: "0".repeat(64),
        createdAt: 100,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Corrupt" },
      })
      const draft = {
        version: 1 as const,
        id: third,
        createdAt: 100,
        source,
        target: { kind: "new" as const, todoID: todo, baseRevision: 0 as const },
        changes: { title: "Miskeyed" },
      }
      yield* storage.write(["raya", "personal-todo-proposals", "v1", other], {
        ...draft,
        digest: PersonalTodoProposal.seal(draft),
      })
      yield* storage.write(["raya", "personal-todo-proposals", "v1", third], {
        version: 1,
        id: third,
        digest: "0".repeat(64),
      })
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const proposals = PersonalTodoProposal.make({ storage })
      const get = yield* proposals.get(id).pipe(Effect.flip)
      expect(get._tag).toBe("PersonalTodoProposalCorruptError")
      const miskeyed = yield* proposals.get(other).pipe(Effect.flip)
      expect(miskeyed._tag).toBe("PersonalTodoProposalCorruptError")
      const malformed = yield* proposals.get(third).pipe(Effect.flip)
      expect(malformed._tag).toBe("PersonalTodoProposalCorruptError")
      const list = yield* proposals.list().pipe(Effect.flip)
      expect(list._tag).toBe("PersonalTodoProposalCorruptError")
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)
