import { describe, expect } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

const todos = [
  [
    { content: "Inspect files", status: "in_progress", priority: "high" },
    { content: "Prepare verification environment", status: "in_progress", priority: "medium" },
    { content: "Run checks", status: "pending", priority: "medium" },
    { content: "Report results", status: "pending", priority: "low" },
  ],
  [
    { content: "Inspect files", status: "completed", priority: "high" },
    { content: "Prepare verification environment", status: "in_progress", priority: "medium" },
    { content: "Run checks", status: "pending", priority: "medium" },
    { content: "Report results", status: "pending", priority: "low" },
  ],
  [
    { content: "Inspect files", status: "completed", priority: "high" },
    { content: "Prepare verification environment", status: "completed", priority: "medium" },
    { content: "Run checks", status: "in_progress", priority: "medium" },
    { content: "Report results", status: "pending", priority: "low" },
  ],
  [
    { content: "Inspect files", status: "completed", priority: "high" },
    { content: "Prepare verification environment", status: "completed", priority: "medium" },
    { content: "Run checks", status: "completed", priority: "medium" },
    { content: "Report results", status: "in_progress", priority: "low" },
  ],
  [
    { content: "Inspect files", status: "completed", priority: "high" },
    { content: "Prepare verification environment", status: "completed", priority: "medium" },
    { content: "Run checks", status: "completed", priority: "medium" },
    { content: "Report results", status: "completed", priority: "low" },
  ],
] as const

describe("todowrite end-to-end", () => {
  cliIt.live(
    "persists parallel and sequential updates through the real CLI session",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({ readyTimeoutMs: 30_000 })
        const client = createKiloClient({ baseUrl: server.url })
        const session = yield* Effect.promise(() =>
          client.session.create({
            permission: [{ permission: "*", action: "allow", pattern: "*" }],
          }),
        )
        const sessionID = session.data?.id
        if (!sessionID) throw new Error("test session was not created")

        for (const list of todos) yield* llm.tool("todowrite", { todos: list })
        yield* llm.text("done")

        const result = yield* opencode.run("complete this four-step task", {
          agent: "code",
          extraArgs: ["--attach", server.url, "--session", sessionID, "--auto"],
          timeoutMs: 90_000,
        })
        if (result.exitCode !== 0) {
          const messages = yield* Effect.promise(() => client.session.messages({ sessionID }))
          const inputs = yield* llm.inputs
          throw new Error(
            JSON.stringify(
              {
                exit: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                requests: inputs.length,
                messages: messages.data?.map((message) => ({
                  info: message.info,
                  parts: message.parts.filter((part) => part.type !== "patch"),
                })),
              },
              null,
              2,
            ),
          )
        }
        opencode.expectExit(result, 0)

        expect(JSON.stringify(yield* llm.inputs), result.stdout + result.stderr).toContain(
          "After completing each item, call this tool before starting the next item",
        )
        const saved = yield* Effect.promise(() => client.session.todo({ sessionID }))
        const final = todos[todos.length - 1]?.map((todo) => ({ ...todo }))
        expect(saved.data).toEqual(final)

        const messages = yield* Effect.promise(() => client.session.messages({ sessionID }))
        expect(JSON.stringify(messages.data)).not.toContain(".local/share/kilo/snapshot/")
        const calls =
          messages.data?.flatMap((message) =>
            message.parts.filter((part) => part.type === "tool" && part.tool === "todowrite"),
          ) ?? []
        expect(calls).toHaveLength(todos.length)
        const first = calls[0]
        if (!first || first.type !== "tool" || first.state.status !== "completed")
          throw new Error("First todo update did not complete")
        expect(JSON.parse(first.state.output)).toEqual(todos[0])
        expect(first.state.metadata?.todos).toEqual(todos[0])
      }),
    120_000,
  )
})
