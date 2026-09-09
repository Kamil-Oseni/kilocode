import { expect, test } from "bun:test"
import { Effect } from "effect"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { outstanding } from "@/kilocode/goal/stop-jobs"

test("stop observation follows completed ancestors and leaves related and unrelated jobs running", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.make
        yield* jobs.start({
          id: "grandchild",
          type: "task",
          title: "Check output",
          metadata: { parentSessionId: "child" },
          run: Effect.never,
        })
        yield* jobs.start({
          id: "child",
          type: "task",
          metadata: { parentSessionId: "root", sessionId: "child" },
          run: Effect.succeed("done"),
        })
        yield* jobs.wait({ id: "child" })
        yield* jobs.start({ id: "other", type: "task", metadata: { parentSessionId: "elsewhere" }, run: Effect.never })
        const result = yield* outstanding("root", jobs)
        expect(result.status).toBe("checked")
        expect(result.jobs).toEqual([{ id: "grandchild", type: "task", title: "Check output" }])
        expect((yield* jobs.get("grandchild"))?.status).toBe("running")
        expect((yield* jobs.get("other"))?.status).toBe("running")
        yield* jobs.cancel("grandchild")
        expect((yield* outstanding("root", jobs)).jobs).toEqual([])
        expect(result.jobs).toHaveLength(1)
      }),
    ),
  )
})

test("failed observation is distinct from an empty registry", async () => {
  const result = await Effect.runPromise(outstanding("root", { list: () => Effect.die("unavailable") }))
  expect(result.status).toBe("unavailable")
  expect(result.jobs).toEqual([])
})
