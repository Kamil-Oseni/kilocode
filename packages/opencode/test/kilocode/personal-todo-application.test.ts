import path from "node:path"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit } from "effect"
import { Git } from "@/git"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { PersonalTodoApplication } from "@/kilocode/personal-todo/application"
import { PersonalTodoProposal } from "@/kilocode/personal-todo/proposal"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const proposal = "proposal_11111111-1111-4111-8111-111111111111"
const second = "proposal_66666666-6666-4666-8666-666666666666"
const todo = "todo_22222222-2222-4222-8222-222222222222"
const sub1 = "subtodo_33333333-3333-4333-8333-333333333333"
const sub2 = "subtodo_44444444-4444-4444-8444-444444444444"
const source = { sessionID: "ses_test", messageID: "msg_test", callID: "call_test" }
const receipt = ["raya", "personal-todo-proposal-applies", "v1"]

it.live("applies a new proposal once and replays its public result after reconstruction", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const first = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const saved = yield* PersonalTodoProposal.make({ storage, now: () => 100 }).propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: {
          title: " Plan the move ",
          detail: "Review leases",
          priority: "high",
          estimateMinutes: 90,
          links: [{ kind: "session", id: "ses_test" }],
          dueAt: 500,
          reminderAt: 400,
          subtasks: [
            { kind: "new", id: sub1, title: "Choose an area", estimateMinutes: 30 },
            { kind: "new", id: sub2, title: "Book viewings", priority: "urgent" },
          ],
        },
      })
      const item = yield* PersonalTodoApplication.make({ storage, now: () => 200 }).apply(saved.id, saved.digest)
      expect(item).toMatchObject({
        version: 2,
        id: todo,
        title: "Plan the move",
        priority: "high",
        estimateMinutes: 90,
        dueAt: 500,
        reminderAt: 400,
        reminderRevision: 1,
        revision: 1,
      })
      expect(item.subtasks?.map((task) => [task.id, task.revision])).toEqual([
        [sub1, 1],
        [sub2, 1],
      ])
      const raw = yield* storage.read<Record<string, unknown>>(["raya", "personal-todos", "v1", todo])
      expect(raw.proposalApply).toEqual({ version: 1, id: proposal, digest: saved.digest })
      expect(item).not.toHaveProperty("proposalApply")
      return { saved, item }
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const app = PersonalTodoApplication.make({ storage, now: () => 999 })
      expect(yield* app.apply(first.saved.id, first.saved.digest)).toEqual(first.item)
      expect((yield* app.reject(first.saved.id, first.saved.digest).pipe(Effect.flip))._tag).toBe(
        "PersonalTodoApplicationConflictError",
      )
      expect((yield* PersonalTodo.make({ storage }).get(todo))?.revision).toBe(1)
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("atomically applies parent fields and ordered new and exact-revision existing subtasks", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, id: () => todo, now: () => 100, subtaskID: () => sub1 })
      const parent = yield* todos.create({ title: "Move", reminderAt: 300, priority: "medium" })
      const withChild = yield* todos.replaceSubtasks(parent.id, {
        revision: parent.revision,
        subtasks: [{ title: "Old step", notes: "clear me", priority: "low" }],
      })
      const child = withChild!.subtasks![0]
      const saved = yield* PersonalTodoProposal.make({ storage, now: () => 200 }).propose({
        id: proposal,
        source,
        target: { kind: "existing", todoID: todo, baseRevision: withChild!.revision },
        changes: {
          title: "Organize the move",
          priority: null,
          reminderAt: 350,
          subtasks: [
            { kind: "existing", id: sub1, revision: child.revision, title: "Keep step", notes: null, priority: null },
            { kind: "new", id: sub2, title: "New step", dueAt: 600 },
          ],
        },
      })
      const item = yield* PersonalTodoApplication.make({ storage, now: () => 300 }).apply(saved.id, saved.digest)
      expect(item).toMatchObject({ title: "Organize the move", reminderAt: 350, revision: withChild!.revision + 1 })
      expect(item.priority).toBeUndefined()
      expect(item.reminderRevision).toBe(item.revision)
      expect(item.subtasks?.map((task) => [task.id, task.title, task.revision])).toEqual([
        [sub1, "Keep step", 2],
        [sub2, "New step", 1],
      ])
      expect(item.subtasks?.[0]).not.toHaveProperty("notes")
      expect(item.subtasks?.[0]).not.toHaveProperty("reminderAt")
      const stale = yield* PersonalTodoProposal.make({ storage, now: () => 400 }).propose({
        id: second,
        source: { ...source, callID: "call_second" },
        target: { kind: "existing", todoID: todo, baseRevision: item.revision },
        changes: {
          subtasks: [{ kind: "existing", id: sub1, revision: 1, title: "Stale child" }],
        },
      })
      const rejected = yield* PersonalTodoApplication.make({ storage, now: () => 500 })
        .apply(stale.id, stale.digest)
        .pipe(Effect.flip)
      expect(rejected._tag).toBe("PersonalTodoApplicationStaleRevisionError")
      expect(yield* todos.get(todo)).toEqual(item)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("rejects a stale base and a changed digest without mutating the Todo", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, id: () => todo, now: () => 100 })
      const base = yield* todos.create({ title: "Original" })
      const saved = yield* PersonalTodoProposal.make({ storage, now: () => 150 }).propose({
        id: proposal,
        source,
        target: { kind: "existing", todoID: todo, baseRevision: base.revision },
        changes: { title: "Proposed" },
      })
      yield* todos.update(todo, { revision: base.revision, title: "Manual" })
      const stale = yield* PersonalTodoApplication.make({ storage, now: () => 200 })
        .apply(saved.id, saved.digest)
        .pipe(Effect.flip)
      expect(stale._tag).toBe("PersonalTodoApplicationStaleRevisionError")
      const changed = yield* PersonalTodoApplication.make({ storage }).apply(saved.id, "0".repeat(64)).pipe(Effect.flip)
      expect(changed._tag).toBe("PersonalTodoApplicationConflictError")
      expect(yield* todos.get(todo)).toMatchObject({ title: "Manual", revision: 2 })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("durably rejects a sealed proposal and replays the exact terminal receipt", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const saved = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const item = yield* PersonalTodoProposal.make({ storage, now: () => 100 }).propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Decline this" },
      })
      const rejected = yield* PersonalTodoApplication.make({ storage, now: () => 200 }).reject(item.id, item.digest)
      expect(rejected).toEqual({
        version: 1,
        state: "rejected",
        proposalID: proposal,
        digest: item.digest,
        rejectedAt: 200,
      })
      expect(rejected).not.toHaveProperty("base")
      expect(rejected).not.toHaveProperty("postimage")
      expect(yield* PersonalTodo.make({ storage }).get(todo)).toBeUndefined()
      return { item, rejected }
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const app = PersonalTodoApplication.make({ storage, now: () => 999 })
      expect(yield* app.reject(saved.item.id, saved.item.digest)).toEqual(saved.rejected)
      expect((yield* app.apply(saved.item.id, saved.item.digest).pipe(Effect.flip))._tag).toBe(
        "PersonalTodoApplicationConflictError",
      )
      expect(yield* PersonalTodo.make({ storage }).get(todo)).toBeUndefined()
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("lets exactly one of concurrent apply and reject claim the proposal", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const saved = yield* PersonalTodoProposal.make({ storage, now: () => 100 }).propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Race" },
      })
      const app = PersonalTodoApplication.make({ storage, now: () => 200 })
      const results = yield* Effect.all(
        [app.apply(saved.id, saved.digest).pipe(Effect.exit), app.reject(saved.id, saved.digest).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      )
      expect(results.reduce((count, result) => count + (Exit.isSuccess(result) ? 1 : 0), 0)).toBe(1)
      const rows = yield* app.list()
      expect(rows).toHaveLength(1)
      expect(["applied", "rejected"]).toContain(rows[0].state)
      expect(Boolean(yield* PersonalTodo.make({ storage }).get(todo))).toBe(rows[0].state === "applied")
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("fails closed while listing malformed and orphan application receipts", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.write([...receipt, "bad"], {})
      expect((yield* PersonalTodoApplication.make({ storage }).list().pipe(Effect.flip))._tag).toBe(
        "PersonalTodoApplicationCorruptError",
      )
      yield* storage.remove([...receipt, "bad"])
      yield* storage.write([...receipt, second], {
        version: 1,
        state: "rejected",
        proposalID: second,
        digest: "0".repeat(64),
        rejectedAt: 100,
      })
      expect((yield* PersonalTodoApplication.make({ storage }).list().pipe(Effect.flip))._tag).toBe(
        "PersonalTodoApplicationCorruptError",
      )
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("rejects receipts that mix terminal and application fields", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const proposals = PersonalTodoProposal.make({ storage, now: () => 100 })
      const rejected = yield* proposals.propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Rejected" },
      })
      const app = PersonalTodoApplication.make({ storage, now: () => 200 })
      const terminal = yield* app.reject(rejected.id, rejected.digest)
      yield* storage.write([...receipt, proposal], { ...terminal, preparedAt: 200 })
      expect((yield* app.reject(rejected.id, rejected.digest).pipe(Effect.flip))._tag).toBe(
        "PersonalTodoApplicationCorruptError",
      )

      const pending = yield* proposals.propose({
        id: second,
        source: { ...source, callID: "call_second" },
        target: { kind: "new", todoID: "todo_77777777-7777-4777-8777-777777777777", baseRevision: 0 },
        changes: { title: "Pending" },
      })
      const broken = {
        ...storage,
        create: (key: string[], value: unknown) =>
          key.slice(0, 4).join("/") === [...receipt, second].join("/")
            ? storage.create(key, value).pipe(Effect.andThen(Effect.die("stop after pending")))
            : storage.create(key, value),
      }
      yield* PersonalTodoApplication.make({ storage: broken, now: () => 300 })
        .apply(pending.id, pending.digest)
        .pipe(Effect.exit)
      const raw = yield* storage.read<Record<string, unknown>>([...receipt, second])
      yield* storage.write([...receipt, second], { ...raw, rejectedAt: 300 })
      expect((yield* app.apply(pending.id, pending.digest).pipe(Effect.flip))._tag).toBe(
        "PersonalTodoApplicationCorruptError",
      )
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("resumes after interruption immediately after the pending receipt", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const saved = yield* PersonalTodoProposal.make({ storage, now: () => 100 }).propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Recover pending" },
      })
      const broken = {
        ...storage,
        create: (key: string[], value: unknown) =>
          key.slice(0, 4).join("/") === [...receipt, proposal].join("/")
            ? storage.create(key, value).pipe(Effect.andThen(Effect.die("stop after pending")))
            : storage.create(key, value),
      }
      expect(
        Exit.isFailure(
          yield* PersonalTodoApplication.make({ storage: broken, now: () => 200 })
            .apply(saved.id, saved.digest)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* PersonalTodo.make({ storage }).get(todo)).toBeUndefined()
      expect(
        (yield* PersonalTodoApplication.make({ storage, now: () => 250 })
          .reject(saved.id, saved.digest)
          .pipe(Effect.flip))._tag,
      ).toBe("PersonalTodoApplicationConflictError")
      expect(
        yield* PersonalTodoApplication.make({ storage, now: () => 300 }).apply(saved.id, saved.digest),
      ).toMatchObject({ revision: 1 })
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("proves and acknowledges a Todo mutation whose receipt acknowledgement was lost", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const saved = yield* PersonalTodoProposal.make({ storage, now: () => 100 }).propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Recover mutation" },
      })
      const broken = {
        ...storage,
        replace: (key: string[], value: unknown) =>
          key.slice(0, 4).join("/") === [...receipt, proposal].join("/")
            ? Effect.die("lost acknowledgement")
            : storage.replace(key, value),
      }
      expect(
        Exit.isFailure(
          yield* PersonalTodoApplication.make({ storage: broken, now: () => 200 })
            .apply(saved.id, saved.digest)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const todos = PersonalTodo.make({ storage, now: () => 250 })
      expect(yield* todos.get(todo)).toMatchObject({ title: "Recover mutation", revision: 1 })
      yield* todos.update(todo, { revision: 1, title: "Later manual edit" })
      expect(
        yield* PersonalTodoApplication.make({ storage, now: () => 300 }).apply(saved.id, saved.digest),
      ).toMatchObject({
        title: "Recover mutation",
        revision: 1,
      })
      expect(yield* todos.get(todo)).toMatchObject({ title: "Later manual edit", revision: 2 })
      expect((yield* storage.read<PersonalTodoApplication.Receipt>([...receipt, proposal])).state).toBe("applied")
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("acknowledges a proven proposal after a later exact deletion", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const saved = yield* PersonalTodoProposal.make({ storage, now: () => 100 }).propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Applied before deletion" },
      })
      const broken = {
        ...storage,
        replace: (key: string[], value: unknown) =>
          key.slice(0, 4).join("/") === [...receipt, proposal].join("/")
            ? Effect.die("lost acknowledgement")
            : storage.replace(key, value),
      }
      expect(
        Exit.isFailure(
          yield* PersonalTodoApplication.make({ storage: broken, now: () => 200 })
            .apply(saved.id, saved.digest)
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const todos = PersonalTodo.make({ storage, now: () => 250 })
      expect(yield* todos.remove(todo, 1)).toBe(true)
      expect(
        yield* PersonalTodoApplication.make({ storage, now: () => 300 }).apply(saved.id, saved.digest),
      ).toMatchObject({
        title: "Applied before deletion",
        revision: 1,
      })
      expect(yield* todos.get(todo)).toBeUndefined()
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("fails closed for a conflicting new target and a corrupt application receipt", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const proposals = PersonalTodoProposal.make({ storage, now: () => 100 })
      const first = yield* proposals.propose({
        id: proposal,
        source,
        target: { kind: "new", todoID: todo, baseRevision: 0 },
        changes: { title: "Conflict" },
      })
      yield* PersonalTodo.make({ storage, id: () => todo, now: () => 110 }).create({ title: "Existing" })
      const conflict = yield* PersonalTodoApplication.make({ storage }).apply(first.id, first.digest).pipe(Effect.flip)
      expect(conflict._tag).toBe("PersonalTodoApplicationConflictError")

      const next = yield* proposals.propose({
        id: second,
        source: { ...source, callID: "call_second" },
        target: { kind: "existing", todoID: todo, baseRevision: 1 },
        changes: { title: "Never applied" },
      })
      yield* storage.write([...receipt, second], { version: 1, state: "pending", proposalID: second })
      const corrupt = yield* PersonalTodoApplication.make({ storage }).apply(next.id, next.digest).pipe(Effect.flip)
      expect(corrupt._tag).toBe("PersonalTodoApplicationCorruptError")
      expect(yield* PersonalTodo.make({ storage }).get(todo)).toMatchObject({ title: "Existing", revision: 1 })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)
