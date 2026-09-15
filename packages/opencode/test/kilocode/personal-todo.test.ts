import path from "node:path"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit } from "effect"
import { Git } from "@/git"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

const first = "todo_11111111-1111-4111-8111-111111111111"
const second = "todo_22222222-2222-4222-8222-222222222222"
const child = "subtodo_33333333-3333-4333-8333-333333333333"
const other = "subtodo_44444444-4444-4444-8444-444444444444"

it.live("persists personal todos across store reconstruction and keeps them outside session todo state", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const create = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, id: () => first, now: () => 100 })
      const item = yield* todos.create({ title: "  Rent a house  ", detail: "Start locally", dueAt: 500 })
      const raw = yield* storage.read<Record<string, unknown>>(["raya", "personal-todos", "v1", first])
      expect(raw).toMatchObject({ version: 1, done: false })
      expect(raw).not.toHaveProperty("status")
      yield* storage.write(["todo", "ses_test"], [{ content: "execution todo" }])
      return item
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))

    expect(create).toEqual({
      version: 1,
      id: first,
      title: "Rent a house",
      detail: "Start locally",
      status: "open",
      done: false,
      dueAt: 500,
      createdAt: 100,
      updatedAt: 100,
      revision: 1,
    })

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, now: () => 200 })
      expect(yield* todos.get(first)).toEqual(create)
      expect(yield* todos.list()).toEqual([create])
      const raw = yield* storage.read<Record<string, unknown>>(["raya", "personal-todos", "v1", first])
      expect(raw).toMatchObject({ version: 1, done: false })
      expect(raw).not.toHaveProperty("status")
      expect(yield* storage.read(["todo", "ses_test"])).toEqual([{ content: "execution todo" }])
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("supports manual create, list, update, completion, reopening, and deletion", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const ids = [first, second]
      const times = [100, 200, 300, 400, 500]
      const todos = PersonalTodo.make({ storage, id: () => ids.shift()!, now: () => times.shift()! })
      const one = yield* todos.create({ title: "First", detail: "Notes", dueAt: 900 })
      const two = yield* todos.create({ title: "Second" })
      expect((yield* todos.list()).map((item) => item.id)).toEqual([second, first])

      const done = yield* todos
        .update(first, {
          revision: one.revision,
          title: "Updated",
          detail: null,
          dueAt: null,
          done: true,
        })
        .pipe(
          Effect.flatMap((item) =>
            item ? Effect.succeed(item) : Effect.die("Expected the first personal todo to exist."),
          ),
        )
      expect(done).toEqual({
        version: 1,
        id: first,
        title: "Updated",
        status: "completed",
        done: true,
        createdAt: 100,
        completedAt: 300,
        updatedAt: 300,
        revision: 2,
      })
      expect((yield* todos.list()).map((item) => item.id)).toEqual([second, first])

      const open = yield* todos
        .update(first, { revision: done.revision, done: false })
        .pipe(
          Effect.flatMap((item) =>
            item ? Effect.succeed(item) : Effect.die("Expected the completed personal todo to reopen."),
          ),
        )
      expect(open).toEqual({
        version: 1,
        id: first,
        title: "Updated",
        status: "open",
        done: false,
        createdAt: 100,
        updatedAt: 400,
        revision: 3,
      })
      expect((yield* todos.update(first, { revision: one.revision, title: "Stale" }).pipe(Effect.flip))._tag).toBe(
        "PersonalTodoStaleRevisionError",
      )
      const stale = yield* todos.remove(first, one.revision).pipe(Effect.flip)
      expect(stale).toMatchObject({
        _tag: "PersonalTodoStaleRevisionError",
        id: first,
        operation: "delete",
        expected: 1,
        actual: 3,
      })
      expect(yield* todos.remove(second, two.revision)).toBe(true)
      expect(yield* todos.remove(second, two.revision)).toBe(false)
      expect(yield* todos.get(second)).toBeUndefined()
      expect(yield* todos.update(second, { revision: two.revision, title: "Already deleted" })).toBeUndefined()
      expect(yield* todos.list()).toEqual([open])
      expect(two.version).toBe(1)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("promotes only extended writes and replaces ordered stable subtasks under one parent revision", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const times = [100, 200, 300, 400, 500, 50]
    const ids = [child, other]
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({
        storage,
        id: () => first,
        subtaskID: () => ids.shift()!,
        now: () => times.shift()!,
      })
      const created = yield* todos.create({ title: "Move house" })
      expect(created).toMatchObject({ version: 1, status: "open", done: false, revision: 1 })

      const renamed = yield* todos.update(first, { revision: 1, title: "Move to Toronto" })
      expect(renamed).toMatchObject({ version: 1, status: "open", revision: 2 })
      const legacy = yield* storage.read<Record<string, unknown>>(["raya", "personal-todos", "v1", first])
      expect(legacy).toMatchObject({ version: 1, revision: 2 })
      expect(legacy).not.toHaveProperty("status")

      const promoted = yield* todos.update(first, {
        revision: 2,
        priority: "high",
        estimateMinutes: 240,
        links: [{ kind: "goal", id: "goal_move" }],
      })
      expect(promoted).toMatchObject({
        version: 2,
        status: "open",
        done: false,
        priority: "high",
        estimateMinutes: 240,
        links: [{ kind: "goal", id: "goal_move" }],
        revision: 3,
      })

      const planned = yield* todos.replaceSubtasks(first, {
        revision: 3,
        subtasks: [
          {
            title: "Set a budget",
            priority: "urgent",
            estimateMinutes: 30,
            reminderAt: 900,
            links: [{ kind: "chat", id: "ses_move" }],
          },
          { title: "Research areas", notes: "Compare transit", dueAt: 800 },
        ],
      })
      expect(planned).toMatchObject({
        version: 2,
        revision: 4,
        subtasks: [
          {
            id: child,
            title: "Set a budget",
            status: "open",
            done: false,
            revision: 1,
            reminderAt: 900,
            reminderRevision: 1,
          },
          { id: other, title: "Research areas", status: "open", done: false, revision: 1 },
        ],
      })
      expect(planned?.subtasks?.map((task) => task.id)).toEqual([child, other])

      const reordered = yield* todos.replaceSubtasks(first, {
        revision: 4,
        subtasks: [
          {
            id: other,
            revision: 1,
            title: "Research neighbourhoods",
            notes: "Compare transit",
            dueAt: 800,
          },
          {
            id: child,
            revision: 1,
            title: "Set a budget",
            priority: "urgent",
            estimateMinutes: 30,
            reminderAt: 900,
            links: [{ kind: "chat", id: "ses_move" }],
          },
        ],
      })
      expect(reordered).toMatchObject({ revision: 5 })
      expect(reordered?.subtasks?.map((task) => [task.id, task.revision])).toEqual([
        [other, 2],
        [child, 1],
      ])

      const completed = yield* todos.completeSubtask(first, {
        revision: 5,
        subtaskID: child,
        subtaskRevision: 1,
      })
      expect(completed).toMatchObject({
        revision: 6,
        status: "open",
        done: false,
        subtasks: [
          { id: other, status: "open", revision: 2 },
          { id: child, status: "completed", done: true, revision: 2, updatedAt: 400, completedAt: 400 },
        ],
      })
      const stale = yield* todos
        .reopenSubtask(first, { revision: 6, subtaskID: child, subtaskRevision: 1 })
        .pipe(Effect.flip)
      expect(stale).toMatchObject({
        _tag: "PersonalTodoSubtaskStaleRevisionError",
        subtaskID: child,
        expected: 1,
        actual: 2,
      })
      const raw = yield* storage.read<Record<string, unknown>>(["raya", "personal-todos", "v1", first])
      const corrupt = { ...raw, status: "completed", done: false }
      yield* storage.write(["raya", "personal-todos", "v1", first], corrupt)
      const exit = yield* todos.update(first, { revision: 6, title: "Must not repair" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* storage.read(["raya", "personal-todos", "v1", first])).toEqual(corrupt)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("rejects invalid input and duplicate identities without overwriting durable data", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, id: () => first, now: () => 100 })
      const item = yield* todos.create({ title: "Keep me" })

      expect((yield* todos.create({ title: "Overwrite" }).pipe(Effect.flip))._tag).toBe("PersonalTodoConflictError")
      expect((yield* todos.create({ title: "   " }).pipe(Effect.flip))._tag).toBe("PersonalTodoInputError")
      expect((yield* todos.update(first, { revision: item.revision, dueAt: Number.NaN }).pipe(Effect.flip)).field).toBe(
        "dueAt",
      )
      expect((yield* todos.update(first, { revision: 0, title: "Invalid" }).pipe(Effect.flip)).field).toBe("revision")
      expect(
        (yield* todos
          .update(first, { revision: item.revision, estimateMinutes: PersonalTodo.MAX_ESTIMATE_MINUTES + 1 })
          .pipe(Effect.flip)).field,
      ).toBe("estimateMinutes")
      expect(
        (yield* todos
          .update(first, {
            revision: item.revision,
            links: [
              { kind: "goal", id: "goal_one" },
              { kind: "goal", id: "goal_one" },
            ],
          })
          .pipe(Effect.flip)).field,
      ).toBe("links")
      expect(
        (yield* todos
          .replaceSubtasks(first, {
            revision: item.revision,
            subtasks: Array.from({ length: PersonalTodo.MAX_SUBTASKS + 1 }, (_, index) => ({
              title: `Subtask ${index}`,
            })),
          })
          .pipe(Effect.flip)).field,
      ).toBe("subtasks")
      const collisions = PersonalTodo.make({ storage, subtaskID: () => child, now: () => 100 })
      expect(
        (yield* collisions
          .replaceSubtasks(first, {
            revision: item.revision,
            subtasks: [{ title: "One" }, { title: "Two" }],
          })
          .pipe(Effect.flip)).field,
      ).toBe("subtasks")
      expect((yield* todos.get("../session").pipe(Effect.flip)).field).toBe("id")
      expect(yield* todos.get(first)).toEqual(item)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("claims due reminders once and recovers expired claims after reconstruction", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const clock = { now: 100 }
    const ids = [first, second]
    const claims = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, id: () => ids.shift()!, now: () => clock.now })
      yield* todos.create({ title: "Call the landlord", reminderAt: 300 })
      yield* todos.create({ title: "Review the budget", reminderAt: 200 })

      clock.now = 199
      expect(yield* todos.claimReminders()).toEqual([])
      clock.now = 300
      const concurrent = yield* Effect.all([todos.claimReminders(), todos.claimReminders()], {
        concurrency: "unbounded",
      })
      const due = concurrent.flat()
      expect(due).toHaveLength(2)
      expect(new Set(due.map((item) => item.deliveryID)).size).toBe(2)
      expect(due.map((item) => item.reminderAt).toSorted((a, b) => a - b)).toEqual([200, 300])
      expect(yield* todos.claimReminders()).toEqual([])
      const firstClaim = due.find((item) => item.todoID === first)!
      const secondClaim = due.find((item) => item.todoID === second)!
      const ack = yield* todos.acknowledge(secondClaim.deliveryID, secondClaim.claimID)
      expect(ack).toMatchObject({
        version: 1,
        state: "acknowledged",
        deliveryID: `${second}_r1`,
        claimID: secondClaim.claimID,
        todoID: second,
        reminderRevision: 1,
        acknowledgedAt: 300,
      })
      return { firstClaim, secondClaim, ack }
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, now: () => clock.now })
      expect(yield* todos.claimReminders()).toEqual([])
      expect(yield* todos.acknowledge(`${second}_r1`, claims.secondClaim.claimID)).toEqual(claims.ack)

      clock.now = 300 + PersonalTodo.REMINDER_LEASE_MS + 1
      const recovered = yield* todos.claimReminders()
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({ deliveryID: `${first}_r1`, todoID: first })
      expect(recovered[0].claimID).not.toBe(claims.firstClaim.claimID)
      expect(yield* todos.acknowledge(recovered[0].deliveryID, claims.firstClaim.claimID)).toBeUndefined()
      expect(yield* todos.acknowledge(recovered[0].deliveryID, recovered[0].claimID)).toMatchObject({
        state: "acknowledged",
        claimID: recovered[0].claimID,
      })

      const sooner = yield* todos.get(second)
      const renamed = yield* todos.update(second, { revision: sooner!.revision, title: "Review rent budget" })
      expect(renamed).toMatchObject({ revision: 2, reminderAt: 200, reminderRevision: 1 })
      expect(yield* todos.claimReminders()).toEqual([])
      const changed = yield* todos.update(second, { revision: renamed!.revision, reminderAt: 350 })
      expect(changed).toMatchObject({ revision: 3, reminderAt: 350, reminderRevision: 3 })
      expect((yield* todos.claimReminders()).map((item) => item.deliveryID)).toEqual([`${second}_r3`])

      const later = yield* todos.get(first)
      const cleared = yield* todos.update(first, { revision: later!.revision, reminderAt: null })
      expect(cleared).not.toHaveProperty("reminderAt")
      expect(cleared).not.toHaveProperty("reminderRevision")
      expect((yield* todos.update(first, { revision: later!.revision, reminderAt: 500 }).pipe(Effect.flip))._tag).toBe(
        "PersonalTodoStaleRevisionError",
      )
      expect((yield* todos.acknowledge("not-a-reminder", recovered[0].claimID).pipe(Effect.flip)).field).toBe(
        "deliveryID",
      )
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live(
  "bounds each reminder claim batch",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const todos = PersonalTodo.make({ storage, now: () => 100 })
        yield* Effect.forEach(
          Array.from({ length: PersonalTodo.REMINDER_CLAIM_LIMIT + 1 }, (_, index) => index),
          (index) => todos.create({ title: `Reminder ${index}`, reminderAt: 0 }),
          { concurrency: 4 },
        )
        expect(yield* todos.claimReminders()).toHaveLength(PersonalTodo.REMINDER_CLAIM_LIMIT)
        expect(yield* todos.claimReminders()).toHaveLength(1)
        expect(yield* todos.claimReminders()).toEqual([])
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  20_000,
)
