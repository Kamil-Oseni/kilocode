import { expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { headers, lane } from "../../../src/kilocode/provider/inference-lane"

test("persisted Routine ancestry selects background while interactive specialists keep chat priority", async () => {
  const runtime = ManagedRuntime.make(Database.layerFromPath(":memory:"))
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db.run(
          "INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('project','C:/fixture',1,1,'[]')",
        )
        for (const [id, parent, metadata] of [
          ["ses_chat", null, null],
          ["ses_specialist", "ses_chat", null],
          ["ses_routine", null, '{"rayaRoutine":{"id":"ses_worker"}}'],
          ["ses_worker", "ses_routine", null],
          ["ses_unknown", null, '{"rayaRoutine":null}'],
          ["ses_cycle", "ses_cycle", null],
        ] as const) {
          const value = (input: string | null) => (input === null ? "NULL" : `'${input}'`)
          yield* database.db.run(
            `INSERT INTO session(id,project_id,parent_id,metadata,slug,directory,title,version,time_created,time_updated) VALUES ('${id}','project',${value(parent)},${value(metadata)},'${id}','C:/fixture','fixture','1',1,1)`,
          )
        }
        expect(yield* lane({ sessionID: "ses_chat" }, database)).toBe("interactive")
        expect(yield* lane({ sessionID: "ses_specialist" }, database)).toBe("interactive")
        expect(yield* lane({ sessionID: "ses_routine" }, database)).toBe("background")
        expect(yield* lane({ sessionID: "ses_worker" }, database)).toBe("background")
        expect(yield* lane({ sessionID: "ses_unknown" }, database)).toBe("background")
        expect(yield* lane({ sessionID: "ses_cycle" }, database)).toBe("background")
        expect(yield* lane({ sessionID: "ses_chat", small: true }, database)).toBe("background")
        expect(yield* lane({ sessionID: "ses_missing" }, database)).toBe("interactive")
      }),
    )
  } finally {
    await runtime.dispose()
  }
})

test("cloud headers preserve identity and only local requests receive the resource hint", () => {
  const input = { "x-value": "unchanged" }
  expect(headers(input, "background", false)).toBe(input)
  const local = headers(input, "background", true)
  expect(local).toHaveProperty("x-raya-inference-lane", "background")
  expect(local["x-value"]).toBe("unchanged")
  expect(input).toEqual({ "x-value": "unchanged" })
})
