import { afterEach, describe, expect, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Schema } from "effect"
import { FocusTimerPaths } from "../../../src/kilocode/server/httpapi/groups/focus-timer"
import { PersonalTodoPaths } from "../../../src/kilocode/server/httpapi/groups/personal-todo"
import { Server } from "../../../src/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

function app() {
  const server = Server.Default().app
  return (path: string, directory: string, method = "GET", body?: unknown) =>
    server.request(path, {
      method,
      headers: { "content-type": "application/json", "x-kilo-directory": directory },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
}

function rec(input: unknown): Record<string, unknown> {
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(input)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi focus timer", () => {
  test("serves revision-fenced timer actions and exact stale conflicts", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const send = app()
    const json = async (path: string, method = "GET", body?: unknown) => {
      const response = await send(path, tmp.path, method, body)
      return { response, data: rec(await response.json()) }
    }

    const idle = await json(FocusTimerPaths.get)
    expect(idle.response.status).toBe(200)
    expect(idle.data).toMatchObject({ version: 1, state: "idle", elapsedMs: 0, remainingMs: 0, revision: 1 })

    const started = await json(FocusTimerPaths.start, "POST", { revision: 1, durationMs: 60_000 })
    expect(started.response.status).toBe(200)
    expect(started.data).toMatchObject({ state: "running", durationMs: 60_000, revision: 2 })

    const paused = await json(FocusTimerPaths.pause, "POST", { revision: 2 })
    expect(paused.response.status).toBe(200)
    expect(paused.data).toMatchObject({ state: "paused", revision: 3 })

    const stale = await json(FocusTimerPaths.resume, "POST", { revision: 2 })
    expect(stale.response.status).toBe(409)
    expect(stale.data).toEqual({
      name: "FocusTimerStaleRevisionError",
      data: {
        operation: "resume",
        expected: 2,
        actual: 3,
        message: "The focus timer changed before this action.",
      },
    })

    const resumed = await json(FocusTimerPaths.resume, "POST", { revision: 3 })
    expect(resumed.response.status).toBe(200)
    expect(resumed.data).toMatchObject({ state: "running", revision: 4 })
    const reset = await json(FocusTimerPaths.reset, "POST", { revision: 4 })
    expect(reset.response.status).toBe(200)
    expect(reset.data).toMatchObject({ state: "idle", elapsedMs: 0, remainingMs: 60_000, revision: 5 })
  }, 15_000)

  test("rejects invalid durations and missing exact todo links", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const send = app()
    const current = rec(await (await send(FocusTimerPaths.get, tmp.path)).json())
    const revision = Number(current.revision)

    const short = await send(FocusTimerPaths.start, tmp.path, "POST", { revision, durationMs: 1 })
    expect(short.status).toBe(400)
    expect(rec(await short.json())).toMatchObject({ kind: "focus-timer", field: "durationMs" })

    const missing = await send(FocusTimerPaths.start, tmp.path, "POST", {
      revision,
      durationMs: 60_000,
      todoID: "todo_11111111-1111-4111-8111-111111111111",
    })
    expect(missing.status).toBe(404)

    const created = await send(PersonalTodoPaths.list, tmp.path, "POST", { title: "Linked work" })
    expect(created.status).toBe(200)
    const todo = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, revision: Schema.Number }))(
      await created.json(),
    )
    const linked = await send(FocusTimerPaths.start, tmp.path, "POST", {
      revision,
      durationMs: 60_000,
      todoID: todo.id,
    })
    expect(linked.status).toBe(200)
    expect(rec(await linked.json())).toMatchObject({ todoID: todo.id, todoExists: true })

    const route = PersonalTodoPaths.item.replace(":todoID", todo.id)
    const removed = await send(`${route}?revision=${todo.revision}`, tmp.path, "DELETE")
    expect(removed.status).toBe(200)
    const retained = await send(FocusTimerPaths.get, tmp.path)
    expect(retained.status).toBe(200)
    expect(rec(await retained.json())).toMatchObject({ state: "running", todoID: todo.id, todoExists: false })
  }, 15_000)
})
