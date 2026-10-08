import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { typedPrompt } from "../src/capture/capture"
import { KiloMemory } from "../src/effect/index"
import type { MemoryPorts } from "../src/effect/ports"
import { MemoryService } from "../src/effect/service"
import { MemoryTimers } from "../src/effect/timers"
import { MemoryTurn } from "../src/effect/turn"
import { MemoryFiles } from "../src/storage/store"

test("a new session digest defers typed capture until idle without losing its message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-capture-deferred-"))
  const calls: string[] = []
  const done = Promise.withResolvers<void>()
  const svc = MemoryService.make()
  svc.setIdleSettle(10)
  const session: MemoryPorts.SessionPort = {
    get: () => Effect.succeed({}),
    readTurn: () =>
      Effect.succeed({
        user: "The Atlas project uses bun run verify-atlas for its integration tests.",
        assistant: "I will use bun run verify-atlas when validating the Atlas integration tests.",
        recent: "Atlas integration test command: bun run verify-atlas.",
        lastAssistantID: "new_assistant",
        sessionModel: { providerID: "fixture", modelID: "capture" },
        recalledMemory: false,
        diffs: [],
      }),
  }
  const model: MemoryPorts.ModelPort = {
    resolve: () => Effect.succeed({ handle: {} }),
    run: async ({ system }) => {
      calls.push(system)
      if (system === typedPrompt) done.resolve()
      return {
        text:
          system === typedPrompt
            ? '{"operations":[{"op":"upsert_environment_fact","section":"Commands","key":"atlas_tests","value":"bun run verify-atlas"}],"skipped":[]}'
            : '{"topic":"Atlas tests","summary":"Use bun run verify-atlas to validate Atlas integration tests."}',
        usage: { totalTokens: 20 },
      }
    },
  }
  try {
    await KiloMemory.enable({ root })
    const state = await MemoryFiles.readState(root)
    await MemoryFiles.writeState(root, {
      ...state,
      stats: { ...state.stats, lastTypedConsolidationAt: Date.now(), lastConsolidatedMessageID: "other_assistant" },
    })
    await Effect.runPromise(
      MemoryTurn.close({ root, sessionID: "new_session", reason: "completed", session, model }).pipe(
        Effect.provideService(MemoryService.Service, svc),
      ),
    )
    await Promise.race([done.promise, Bun.sleep(1000)])
    expect(calls.filter((system) => system === typedPrompt)).toHaveLength(1)
    // The model callback precedes applying its output; join the real turn semaphore before inspecting storage.
    await Effect.runPromise(svc.turnLock("new_session").withPermits(1)(Effect.void))
    svc.dropLock("new_session")
    expect((await KiloMemory.show({ root })).sources.environment).toContain("bun run verify-atlas")
    expect((await MemoryFiles.readState(root)).stats.lastConsolidatedMessageID).toBe("new_assistant")
    await Effect.runPromise(
      MemoryTurn.close({ root, sessionID: "new_session", reason: "completed", session, model }).pipe(
        Effect.provideService(MemoryService.Service, svc),
      ),
    )
    await Bun.sleep(40)
    expect(calls.filter((system) => system === typedPrompt)).toHaveLength(1)
  } finally {
    MemoryTimers.clear(root)
    await Effect.runPromise(svc.turnLock("new_session").withPermits(1)(Effect.void))
    svc.dropLock("new_session")
    await rm(root, { recursive: true, force: true })
  }
})
