// kilocode_change - new file
import { afterAll, afterEach, expect, setDefaultTimeout } from "bun:test"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { cleanup } from "./personal-todo-environment"
import { Effect, Schema } from "effect"
import { Git } from "@/git"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { PersonalTodoProposal } from "@/kilocode/personal-todo/proposal"
import { Storage } from "@/storage/storage"
import { Global } from "@opencode-ai/core/global"
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

        const reminderResponse = yield* request(tmp.path, "/raya/personal-todos", {
          method: "POST",
          body: JSON.stringify({ title: "Call the landlord", reminderAt: 0 }),
        })
        expect(reminderResponse.status).toBe(200)
        const reminder = yield* json(reminderResponse).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PersonalTodo.Info)),
        )
        const dueResponses = yield* Effect.all(
          [
            request(tmp.path, "/raya/personal-todos/reminders/claim", { method: "POST" }),
            request(tmp.path, "/raya/personal-todos/reminders/claim", { method: "POST" }),
          ],
          { concurrency: "unbounded" },
        )
        expect(dueResponses.map((response) => response.status)).toEqual([200, 200])
        const due = (yield* Effect.forEach(dueResponses, (response) =>
          json(response).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PersonalTodo.Reminder)))),
        )).flat()
        expect(due).toHaveLength(1)
        expect(due).toEqual([
          expect.objectContaining({
            deliveryID: `${reminder.id}_r1`,
            todoID: reminder.id,
            todoRevision: 1,
            reminderRevision: 1,
            reminderAt: 0,
          }),
        ])
        const acknowledgedResponse = yield* request(tmp.path, "/raya/personal-todos/reminders/acknowledge", {
          method: "POST",
          body: JSON.stringify({ deliveryID: due[0].deliveryID, claimID: due[0].claimID }),
        })
        expect(acknowledgedResponse.status).toBe(200)
        expect(yield* json(acknowledgedResponse)).toMatchObject({
          version: 1,
          state: "acknowledged",
          deliveryID: due[0].deliveryID,
          claimID: due[0].claimID,
          todoID: reminder.id,
          todoRevision: 1,
          reminderRevision: 1,
        })
        expect(
          yield* json(yield* request(tmp.path, "/raya/personal-todos/reminders/claim", { method: "POST" })),
        ).toEqual([])
        const repeatedAck = yield* request(tmp.path, "/raya/personal-todos/reminders/acknowledge", {
          method: "POST",
          body: JSON.stringify({ deliveryID: due[0].deliveryID, claimID: due[0].claimID }),
        })
        expect(repeatedAck.status).toBe(200)
        expect(yield* json(repeatedAck)).toMatchObject({ deliveryID: due[0].deliveryID })
        expect(
          (yield* request(tmp.path, "/raya/personal-todos/reminders/acknowledge", {
            method: "POST",
            body: JSON.stringify({ deliveryID: `${reminder.id}_r999`, claimID: due[0].claimID }),
          })).status,
        ).toBe(404)

        const clearedResponse = yield* request(tmp.path, `/raya/personal-todos/${reminder.id}`, {
          method: "PATCH",
          body: JSON.stringify({ revision: 1, reminderAt: null }),
        })
        expect(clearedResponse.status).toBe(200)
        const cleared = yield* json(clearedResponse)
        expect(cleared).toMatchObject({ id: reminder.id, revision: 2 })
        expect(cleared).not.toHaveProperty("reminderAt")
        expect(cleared).not.toHaveProperty("reminderRevision")
        expect(
          (yield* request(tmp.path, `/raya/personal-todos/${reminder.id}`, {
            method: "PATCH",
            body: JSON.stringify({ revision: 1, reminderAt: 0 }),
          })).status,
        ).toBe(409)
        const resetResponse = yield* request(tmp.path, `/raya/personal-todos/${reminder.id}`, {
          method: "PATCH",
          body: JSON.stringify({ revision: 2, reminderAt: 0 }),
        })
        expect(resetResponse.status).toBe(200)
        expect(yield* json(resetResponse)).toMatchObject({ revision: 3, reminderAt: 0, reminderRevision: 3 })
        const resetDue = yield* json(
          yield* request(tmp.path, "/raya/personal-todos/reminders/claim", { method: "POST" }),
        )
        expect(resetDue).toEqual([expect.objectContaining({ deliveryID: `${reminder.id}_r3` })])
        const finalClear = yield* request(tmp.path, `/raya/personal-todos/${reminder.id}`, {
          method: "PATCH",
          body: JSON.stringify({ revision: 3, reminderAt: null }),
        })
        expect(finalClear.status).toBe(200)
        expect(
          yield* json(yield* request(tmp.path, "/raya/personal-todos/reminders/claim", { method: "POST" })),
        ).toEqual([])

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

it.live("lists, gets, and idempotently applies durable personal Todo proposals", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
    (tmp) =>
      Effect.gen(function* () {
        const proposalID = "proposal_11111111-1111-4111-8111-111111111111"
        const staleID = "proposal_22222222-2222-4222-8222-222222222222"
        const rejectedID = "proposal_55555555-5555-4555-8555-555555555555"
        const todoID = "todo_33333333-3333-4333-8333-333333333333"
        const rejectedTodoID = "todo_66666666-6666-4666-8666-666666666666"
        const source = { sessionID: "ses_http", messageID: "msg_http", callID: "call_http" }
        const propose = (input: PersonalTodoProposal.Input) =>
          Storage.Service.use((storage) => PersonalTodoProposal.make({ storage }).propose(input)).pipe(
            Effect.provide(Storage.layerFromDir(path.join(Global.Path.data, "storage"))),
            Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
          )
        const saved = yield* propose({
          id: proposalID,
          source,
          target: { kind: "new", todoID, baseRevision: 0 },
          changes: {
            title: "Plan the move",
            subtasks: [
              {
                kind: "new",
                id: "subtodo_44444444-4444-4444-8444-444444444444",
                title: "Book viewings",
              },
            ],
          },
        })

        const listed = yield* request(tmp.path, "/raya/personal-todos/proposals")
        expect(listed.status).toBe(200)
        expect(yield* json(listed)).toEqual([
          expect.objectContaining({ proposal: expect.objectContaining({ id: proposalID }), state: "open" }),
        ])

        const fetched = yield* request(tmp.path, `/raya/personal-todos/proposals/${proposalID}`)
        expect(fetched.status).toBe(200)
        expect(yield* json(fetched)).toMatchObject({
          proposal: { id: proposalID, digest: saved.digest },
          state: "open",
        })

        const invalid = yield* request(tmp.path, `/raya/personal-todos/proposals/${proposalID}/apply`, {
          method: "POST",
          body: JSON.stringify({ digest: "invalid" }),
        })
        expect(invalid.status).toBe(400)

        const conflict = yield* request(tmp.path, `/raya/personal-todos/proposals/${proposalID}/apply`, {
          method: "POST",
          body: JSON.stringify({ digest: "0".repeat(64) }),
        })
        expect(conflict.status).toBe(409)

        const apply = () =>
          request(tmp.path, `/raya/personal-todos/proposals/${proposalID}/apply`, {
            method: "POST",
            body: JSON.stringify({ digest: saved.digest }),
          })
        const applied = yield* apply()
        expect(applied.status).toBe(200)
        const view = yield* json(applied)
        expect(view).toMatchObject({
          proposal: { id: proposalID, digest: saved.digest },
          state: "applied",
          todo: { id: todoID, title: "Plan the move", revision: 1 },
        })
        const replayed = yield* apply()
        expect(replayed.status).toBe(200)
        expect(yield* json(replayed)).toEqual(view)

        const rejected = yield* propose({
          id: rejectedID,
          source: { ...source, callID: "call_reject" },
          target: { kind: "new", todoID: rejectedTodoID, baseRevision: 0 },
          changes: { title: "Declined plan", detail: "Keep this proposal for review history" },
        })
        const reject = (id: string, digest: string) =>
          request(tmp.path, `/raya/personal-todos/proposals/${id}/reject`, {
            method: "POST",
            body: JSON.stringify({ digest }),
          })
        const rejectedResponse = yield* reject(rejected.id, rejected.digest)
        expect(rejectedResponse.status).toBe(200)
        const rejectedView = yield* json(rejectedResponse)
        expect(rejectedView).toMatchObject({
          proposal: { id: rejectedID, digest: rejected.digest },
          state: "rejected",
        })
        expect(rejectedView).not.toHaveProperty("todo")
        const repeatedReject = yield* reject(rejected.id, rejected.digest)
        expect(repeatedReject.status).toBe(200)
        expect(yield* json(repeatedReject)).toEqual(rejectedView)

        const applyRejected = yield* request(tmp.path, `/raya/personal-todos/proposals/${rejected.id}/apply`, {
          method: "POST",
          body: JSON.stringify({ digest: rejected.digest }),
        })
        expect(applyRejected.status).toBe(409)
        const rejectApplied = yield* reject(saved.id, saved.digest)
        expect(rejectApplied.status).toBe(409)

        const fetchedRejected = yield* request(tmp.path, `/raya/personal-todos/proposals/${rejected.id}`)
        expect(fetchedRejected.status).toBe(200)
        expect(yield* json(fetchedRejected)).toEqual(rejectedView)

        const stale = yield* propose({
          id: staleID,
          source: { ...source, callID: "call_stale" },
          target: { kind: "existing", todoID, baseRevision: 1 },
          changes: { title: "Stale proposal" },
        })
        const updated = yield* request(tmp.path, `/raya/personal-todos/${todoID}`, {
          method: "PATCH",
          body: JSON.stringify({ revision: 1, title: "Manual edit" }),
        })
        expect(updated.status).toBe(200)
        const staleResponse = yield* request(tmp.path, `/raya/personal-todos/proposals/${staleID}/apply`, {
          method: "POST",
          body: JSON.stringify({ digest: stale.digest }),
        })
        expect(staleResponse.status).toBe(409)
        expect(yield* json(staleResponse)).toEqual({
          name: "PersonalTodoProposalStaleRevisionError",
          data: {
            proposalID: staleID,
            todoID,
            expected: 1,
            actual: 2,
            message: "The personal Todo changed before this proposal was applied.",
          },
        })

        expect(
          (yield* request(tmp.path, "/raya/personal-todos/proposals/proposal_99999999-9999-4999-8999-999999999999"))
            .status,
        ).toBe(404)

        const final = yield* json(yield* request(tmp.path, "/raya/personal-todos/proposals"))
        expect(final).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ proposal: expect.objectContaining({ id: saved.id }), state: "applied" }),
            expect.objectContaining({ proposal: expect.objectContaining({ id: rejected.id }), state: "rejected" }),
            expect.objectContaining({ proposal: expect.objectContaining({ id: stale.id }), state: "open" }),
          ]),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
