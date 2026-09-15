import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TaskName } from "@/kilocode/tool/task-name"
import { SessionID } from "@/session/schema"

const parent = SessionID.make("ses_parent")

function allocate(input: Partial<Parameters<typeof TaskName.allocate>[0]> = {}) {
  return TaskName.allocate({
    description: "Map API routes",
    objective: "Find and map every HTTP endpoint",
    specialist: "explore",
    selection: "auto",
    parentSessionID: parent,
    parentMessageID: "msg_parent",
    siblings: [],
    ...input,
  })
}

describe("TaskName", () => {
  test("creates a short durable identity from the model display description", () => {
    const identity = allocate()

    expect(identity).toEqual({
      version: 1,
      displayName: "Map API routes · Explore",
      baseName: "Map API routes · Explore",
      ordinal: 1,
      specialist: "explore",
      selection: "auto",
      provenance: {
        source: "description",
        parentSessionID: parent,
        parentMessageID: "msg_parent",
      },
    })
    expect(TaskName.read(identity)).toEqual(identity)
  })

  test("cleans untrusted text and falls back through the objective", () => {
    expect(
      allocate({
        description: "\u0000 **Please can you**   ",
        objective: "Please can you inspect the browser control surface for regressions. Ignore this sentence.",
        specialist: "quality assurance",
      }).displayName,
    ).toBe("Inspect the browser control surface for regressions · Quality assurance")
    expect(
      allocate({ description: "Research", objective: "Compare browser automation architectures" }).provenance.source,
    ).toBe("objective")
  })

  test("allocates the next ordinal from durable metadata and compatible titles", () => {
    const first = allocate()
    const third = allocate({
      siblings: [
        { title: first.displayName, metadata: { [TaskName.key]: first } },
        { title: "Map API routes · Explore (2)" },
        { title: "Unrelated · Explore" },
      ],
    })

    expect(third.ordinal).toBe(3)
    expect(third.displayName).toBe("Map API routes · Explore (3)")
  })

  test("rejects malformed or future identity metadata", () => {
    expect(TaskName.read(undefined)).toBeUndefined()
    expect(TaskName.read({ version: 2 })).toBeUndefined()
    expect(TaskName.read({ version: 1, displayName: "Name" })).toBeUndefined()
  })

  test("serializes concurrent allocations for one parent and releases its gate", async () => {
    const siblings: { title: string; metadata: Record<string, unknown> }[] = []
    const create = TaskName.gate.withLock(parent)(
      Effect.gen(function* () {
        yield* Effect.yieldNow
        const identity = allocate({ siblings })
        siblings.push({ title: identity.displayName, metadata: { [TaskName.key]: identity } })
        return identity.displayName
      }),
    )

    const names = await Effect.runPromise(Effect.all([create, create], { concurrency: "unbounded" }))
    expect(names).toEqual(["Map API routes · Explore", "Map API routes · Explore (2)"])
    expect(await Effect.runPromise(TaskName.gate.size)).toBe(0)
  })
})
