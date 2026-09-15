// kilocode_change - new file
import { afterAll, afterEach, expect, setDefaultTimeout } from "bun:test"
import { cleanup } from "./personal-todo-environment"
import { Effect, Schema } from "effect"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Server } from "@/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { it } from "../lib/effect"

setDefaultTimeout(15_000)

const json = (response: Response) => Effect.promise<unknown>(() => response.json())

function request(directory: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-kilo-directory", directory)
  if (init.body) headers.set("content-type", "application/json")
  return Effect.promise(() => Promise.resolve(Server.Default().app.request(path, { ...init, headers })))
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

afterAll(async () => {
  await cleanup()
})

it.live("serves typed personal todo CRUD and exact stale revision conflicts", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
    (tmp) =>
      Effect.gen(function* () {
        const createdResponse = yield* request(tmp.path, "/raya/personal-todos", {
          method: "POST",
          body: JSON.stringify({ title: "Rent a house", detail: "Choose a city", dueAt: 900 }),
        })
        expect(createdResponse.status).toBe(200)
        const created = yield* json(createdResponse).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PersonalTodo.Info)))
        expect(created).toMatchObject({ version: 1, revision: 1, title: "Rent a house", done: false })

        const listed = yield* request(tmp.path, "/raya/personal-todos")
        expect(listed.status).toBe(200)
        expect(yield* json(listed)).toEqual([expect.objectContaining({ id: created.id, revision: 1 })])

        const fetched = yield* request(tmp.path, `/raya/personal-todos/${created.id}`)
        expect(fetched.status).toBe(200)
        expect(yield* json(fetched)).toMatchObject({ id: created.id, revision: 1 })

        const missingUpdateRevision = yield* request(tmp.path, `/raya/personal-todos/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ done: true }),
        })
        expect(missingUpdateRevision.status).toBe(400)

        const updatedResponse = yield* request(tmp.path, `/raya/personal-todos/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ revision: 1, done: true }),
        })
        expect(updatedResponse.status).toBe(200)
        const updated = yield* json(updatedResponse).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PersonalTodo.Info)))
        expect(updated).toMatchObject({ revision: 2, done: true })

        const staleUpdate = yield* request(tmp.path, `/raya/personal-todos/${created.id}`, {
          method: "PATCH",
          body: JSON.stringify({ revision: 1, title: "Stale title" }),
        })
        expect(staleUpdate.status).toBe(409)
        expect(yield* json(staleUpdate)).toEqual({
          name: "PersonalTodoStaleRevisionError",
          data: {
            id: created.id,
            operation: "update",
            expected: 1,
            actual: 2,
            message: "The personal todo changed before this update.",
          },
        })

        const missingDeleteRevision = yield* request(tmp.path, `/raya/personal-todos/${created.id}`, {
          method: "DELETE",
        })
        expect(missingDeleteRevision.status).toBe(400)

        const staleDelete = yield* request(tmp.path, `/raya/personal-todos/${created.id}?revision=1`, {
          method: "DELETE",
        })
        expect(staleDelete.status).toBe(409)
        expect(yield* json(staleDelete)).toEqual({
          name: "PersonalTodoStaleRevisionError",
          data: {
            id: created.id,
            operation: "delete",
            expected: 1,
            actual: 2,
            message: "The personal todo changed before this deletion.",
          },
        })

        const removed = yield* request(tmp.path, `/raya/personal-todos/${created.id}?revision=2`, {
          method: "DELETE",
        })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toBe(true)
        expect((yield* request(tmp.path, `/raya/personal-todos/${created.id}`)).status).toBe(404)
        expect(
          (yield* request(tmp.path, `/raya/personal-todos/${created.id}`, {
            method: "PATCH",
            body: JSON.stringify({ revision: 2, title: "Already deleted" }),
          })).status,
        ).toBe(404)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
