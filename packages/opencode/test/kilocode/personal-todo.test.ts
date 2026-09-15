import path from "node:path"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Git } from "@/git"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

const first = "todo_11111111-1111-4111-8111-111111111111"
const second = "todo_22222222-2222-4222-8222-222222222222"

it.live("persists personal todos across store reconstruction and keeps them outside session todo state", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const create = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, id: () => first, now: () => 100 })
      const item = yield* todos.create({ title: "  Rent a house  ", detail: "Start locally", dueAt: 500 })
      yield* storage.write(["todo", "ses_test"], [{ content: "execution todo" }])
      return item
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))

    expect(create).toEqual({
      version: 1,
      id: first,
      title: "Rent a house",
      detail: "Start locally",
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
        ...one,
        title: "Updated",
        detail: undefined,
        dueAt: undefined,
        done: true,
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
      expect(open).toEqual({ ...done, done: false, completedAt: undefined, updatedAt: 400, revision: 3 })
      expect((yield* todos.update(first, { revision: one.revision, title: "Stale" }).pipe(Effect.flip))._tag).toBe(
        "PersonalTodoConflictError",
      )
      expect(yield* todos.remove(second, two.revision)).toBe(true)
      expect(yield* todos.remove(second, two.revision)).toBe(false)
      expect(yield* todos.get(second)).toBeUndefined()
      expect(yield* todos.list()).toEqual([open])
      expect(two.version).toBe(1)
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
      expect((yield* todos.get("../session").pipe(Effect.flip)).field).toBe("id")
      expect(yield* todos.get(first)).toEqual(item)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)
