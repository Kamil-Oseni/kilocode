import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "successful attached CLI preserves output and exits zero",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      const server = yield* opencode.serve({ readyTimeoutMs: 30_000 })
      yield* llm.text("Attached response completed")
      const result = yield* opencode.run("Return the test response", {
        agent: "code",
        extraArgs: ["--attach", server.url, "--auto"],
        timeoutMs: 45_000,
      })
      opencode.expectExit(result, 0)
      expect(result.stdout).toContain("Attached response completed")
      expect((yield* llm.inputs).length).toBeGreaterThan(0)
    }),
  90_000,
)

cliIt.live(
  "attached CLI exits nonzero when its session reports a provider failure",
  ({ llm, opencode }) =>
    Effect.gen(function* () {
      const server = yield* opencode.serve({ readyTimeoutMs: 30_000 })
      yield* llm.error(400, { error: { message: "attached provider failed" } })
      const result = yield* opencode.run("Trigger the provider error", {
        agent: "code",
        extraArgs: ["--attach", server.url, "--auto"],
        timeoutMs: 45_000,
      })
      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("attached provider failed")
      expect((yield* llm.inputs).length).toBeGreaterThan(0)
    }),
  90_000,
)
