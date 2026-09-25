import { afterEach, expect, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Schema } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { PersonalTodoPaths } from "@/kilocode/server/httpapi/groups/personal-todo"
import { Server } from "@/server/server"
import { Storage } from "@/storage/storage"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("subtask HTTP actions require exact parent and child revisions", async () => {
  await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
  const app = Server.Default().app
  const headers = { "content-type": "application/json", "x-kilo-directory": tmp.path }
  const send = async (route: string, method: string, payload?: unknown) => {
    const response = await app.request(route, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await response.json()),
    }
  }
  const created = await send(PersonalTodoPaths.list, "POST", { title: "Learn violin" })
  expect(created.status).toBe(200)
  const id = String(created.body.id)
  const planned = await AppRuntime.runPromise(
    Storage.Service.use((storage) =>
      PersonalTodo.make({ storage }).replaceSubtasks(id, {
        revision: Number(created.body.revision),
        subtasks: [{ title: "Find a violin" }],
      }),
    ),
  )
  if (!planned?.subtasks?.[0]) throw new Error("The parent Todo needs one saved subtask.")
  const child = planned.subtasks[0]
  const complete = PersonalTodoPaths.completeSubtask.replace(":todoID", id).replace(":subtaskID", child.id)
  const reopen = PersonalTodoPaths.reopenSubtask.replace(":todoID", id).replace(":subtaskID", child.id)

  const missingRevision = await send(complete, "POST", { revision: planned.revision })
  expect(missingRevision.status).toBe(400)
  const invalidRevision = await send(complete, "POST", { revision: 0, subtaskRevision: 1 })
  expect(invalidRevision).toMatchObject({ status: 400, body: { field: "revision" } })
  const missingChild = await send(complete.replace(child.id, "subtodo_11111111-1111-4111-8111-111111111111"), "POST", {
    revision: planned.revision,
    subtaskRevision: 1,
  })
  expect(missingChild.status).toBe(404)

  const staleParent = await send(complete, "POST", { revision: 1, subtaskRevision: 1 })
  expect(staleParent).toMatchObject({ status: 409, body: { name: "PersonalTodoStaleRevisionError" } })

  const completed = await send(complete, "POST", { revision: planned.revision, subtaskRevision: child.revision })
  expect(completed).toMatchObject({ status: 200, body: { revision: planned.revision + 1 } })
  const done = Schema.decodeUnknownSync(PersonalTodo.Info)(completed.body)
  expect(done.subtasks?.[0]).toMatchObject({
    done: true,
    revision: child.revision + 1,
  })

  const staleChild = await send(reopen, "POST", {
    revision: Number(completed.body.revision),
    subtaskRevision: child.revision,
  })
  expect(staleChild).toMatchObject({
    status: 409,
    body: {
      name: "PersonalTodoSubtaskStaleRevisionError",
      data: { id, subtaskID: child.id, expected: child.revision, actual: child.revision + 1 },
    },
  })

  const reopened = await send(reopen, "POST", {
    revision: Number(completed.body.revision),
    subtaskRevision: child.revision + 1,
  })
  expect(reopened.status).toBe(200)
  const open = Schema.decodeUnknownSync(PersonalTodo.Info)(reopened.body)
  expect(open.subtasks?.[0]).toMatchObject({
    done: false,
    revision: child.revision + 2,
  })

  const replay = await send(reopen, "POST", {
    revision: Number(completed.body.revision),
    subtaskRevision: child.revision + 1,
  })
  expect(replay).toMatchObject({ status: 409, body: { name: "PersonalTodoStaleRevisionError" } })
}, 15_000)
