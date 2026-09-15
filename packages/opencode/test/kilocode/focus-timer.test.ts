import path from "node:path"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Git } from "@/git"
import { FocusTimer } from "@/kilocode/focus-timer"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const todoID = "todo_11111111-1111-4111-8111-111111111111"

it.live("persists wall-clock progress across reconstruction and clamps clock regression", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const dir = path.join(root, "storage")
    const time = { value: 1_000 }
    const started = yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage })
      const timer = FocusTimer.make({ storage, todos, now: () => time.value })
      const idle = yield* timer.get()
      expect(idle).toMatchObject({ version: 1, state: "idle", elapsedMs: 0, remainingMs: 0, revision: 1 })
      yield* storage.write(["todo", "ses_test"], [{ content: "execution todo" }])
      return yield* timer.start({ revision: idle.revision, durationMs: 60_000 })
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    expect(started).toMatchObject({ state: "running", elapsedMs: 0, remainingMs: 60_000, revision: 2 })

    time.value = 21_000
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage })
      const timer = FocusTimer.make({ storage, todos, now: () => time.value })
      expect(yield* timer.get()).toMatchObject({
        state: "running",
        elapsedMs: 20_000,
        remainingMs: 40_000,
        revision: 2,
      })
      expect(yield* storage.read(["todo", "ses_test"])).toEqual([{ content: "execution todo" }])
      time.value = 500
      expect(yield* timer.get()).toMatchObject({
        state: "running",
        elapsedMs: 20_000,
        remainingMs: 40_000,
        revision: 2,
      })
    }).pipe(Effect.provide(Storage.layerFromDir(dir)))
  }),
)

it.live("atomically pauses, resumes, completes, resets, and rejects stale concurrent actions", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const time = { value: 1_000 }
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage })
      const timer = FocusTimer.make({ storage, todos, now: () => time.value })
      const idle = yield* timer.get()
      const running = yield* timer.start({ revision: idle.revision, durationMs: 60_000 })
      time.value = 11_000
      const paused = yield* timer.pause(running.revision)
      expect(paused).toMatchObject({ state: "paused", elapsedMs: 10_000, remainingMs: 50_000, revision: 3 })
      const stale = yield* timer.resume(running.revision).pipe(Effect.flip)
      expect(stale).toMatchObject({ _tag: "FocusTimerStaleRevisionError", operation: "resume", expected: 2, actual: 3 })
      time.value = 20_000
      const resumed = yield* timer.resume(paused.revision)
      expect(resumed).toMatchObject({ state: "running", elapsedMs: 10_000, remainingMs: 50_000, revision: 4 })
      time.value = 70_000
      const completed = yield* timer.get()
      expect(completed).toMatchObject({ state: "completed", elapsedMs: 60_000, remainingMs: 0, revision: 5 })
      const reset = yield* timer.reset(completed.revision)
      expect(reset).toMatchObject({ state: "idle", durationMs: 60_000, elapsedMs: 0, remainingMs: 60_000, revision: 6 })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("validates todo links at start and reports a later deleted link without stopping the timer", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const time = { value: 1_000 }
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage, id: () => todoID, now: () => time.value })
      const timer = FocusTimer.make({ storage, todos, now: () => time.value })
      const idle = yield* timer.get()
      const missing = yield* timer.start({ revision: idle.revision, durationMs: 60_000, todoID }).pipe(Effect.flip)
      expect(missing).toMatchObject({ _tag: "FocusTimerTodoNotFoundError", todoID })
      const todo = yield* todos.create({ title: "Review accounts" })
      const running = yield* timer.start({ revision: idle.revision, durationMs: 60_000, todoID })
      expect(running).toMatchObject({ todoID, todoExists: true })
      expect(yield* todos.remove(todoID, todo.revision)).toBe(true)
      time.value = 2_000
      expect(yield* timer.get()).toMatchObject({ state: "running", todoID, todoExists: false, elapsedMs: 1_000 })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("rejects duration bounds without changing the retained revision", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage })
      const timer = FocusTimer.make({ storage, todos, now: () => 1_000 })
      const idle = yield* timer.get()
      expect(yield* timer.start({ revision: idle.revision, durationMs: 59_999 }).pipe(Effect.flip)).toMatchObject({
        _tag: "FocusTimerInputError",
        field: "durationMs",
      })
      expect(yield* timer.start({ revision: idle.revision, durationMs: 86_400_001 }).pipe(Effect.flip)).toMatchObject({
        _tag: "FocusTimerInputError",
        field: "durationMs",
      })
      expect((yield* timer.get()).revision).toBe(idle.revision)
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)

it.live("projects elapsed completion truthfully when the persisted revision is saturated", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const todos = PersonalTodo.make({ storage })
      const timer = FocusTimer.make({ storage, todos, now: () => 61_000 })
      yield* storage.write(["raya", "focus-timer", "v1", "state"], {
        version: 1,
        state: "running",
        durationMs: 60_000,
        elapsedMs: 0,
        startedAt: 1_000,
        runStartedAt: 1_000,
        updatedAt: 1_000,
        revision: Number.MAX_SAFE_INTEGER,
      })
      const completed = yield* timer.get()
      expect(completed).toMatchObject({
        state: "completed",
        elapsedMs: 60_000,
        remainingMs: 0,
        completedAt: 61_000,
        revision: Number.MAX_SAFE_INTEGER,
      })
      expect(yield* storage.read(["raya", "focus-timer", "v1", "state"])).toMatchObject({ state: "running" })
    }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
  }),
)
