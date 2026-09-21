import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import { RayaGoalHealth } from "@/kilocode/goal/health"

const state = (status: "active" | "paused" | "complete" | "blocked") => ({
  objective: "private objective",
  status,
  createdAt: 1,
  updatedAt: 1,
  usage: { turns: 0, continuations: 0, toolCalls: 0 },
  progress: [],
})

function storage(entries: Map<string, unknown>): Pick<Storage.Interface, "list" | "read"> {
  return {
    list: () => Effect.succeed([...entries.keys()].map((id) => ["raya", "goal", id])),
    read: <T>(key: string[]) => Effect.succeed(entries.get(key.at(-1)!) as T),
  }
}

describe("Raya goal health", () => {
  test("counts decoded states and contains malformed private records", async () => {
    const entries = new Map<string, unknown>([
      ["one", state("active")],
      ["two", state("paused")],
      ["three", state("blocked")],
      ["private-session", { objective: "synthetic-goal-secret" }],
    ])
    const result = await Effect.runPromise(RayaGoalHealth.inspect(storage(entries)))
    expect(result).toEqual({ goals: 4, active: 1, paused: 1, blocked: 1, failed: 1, incomplete: 0 })
    expect(JSON.stringify(result)).not.toContain("private")
    expect(JSON.stringify(result)).not.toContain("synthetic")
  })

  test("caps record reads and reports the unchecked remainder", async () => {
    const entries = new Map(Array.from({ length: 260 }, (_, index) => [`goal-${index}`, state("complete")]))
    let reads = 0
    const source = storage(entries)
    const result = await Effect.runPromise(
      RayaGoalHealth.inspect({
        ...source,
        read: <T>(key: string[]) => {
          reads++
          return source.read<T>(key)
        },
      }),
    )
    expect(reads).toBe(256)
    expect(result).toEqual({ goals: 260, active: 0, paused: 0, blocked: 0, failed: 0, incomplete: 4 })
  })
})
