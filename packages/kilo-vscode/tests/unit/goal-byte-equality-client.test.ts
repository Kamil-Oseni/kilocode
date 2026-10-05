import { expect, test } from "bun:test"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { editGoal } from "../../src/kilo-provider/goal"
import { valid, equal } from "../../src/shared/goal-criteria"
import { report } from "../../src/shared/goal-report"
import type { GoalState } from "../../src/shared/goal"

const criteria: NonNullable<GoalState["criteria"]> = [
  {
    id: "bytes",
    description: "Exact copy",
    verification: "Read both files",
    review: true,
    check: {
      kind: "byte-equality",
      source: { path: "C:/work/input.txt", canonical: "C:/work/input.txt", sha256: "a".repeat(64), bytes: 48 },
      target: { path: "C:/work/result.txt", canonical: "C:/work/result.txt" },
    },
  },
]

test("saved equality validates every binding field and exact acknowledgement", () => {
  expect(valid(criteria)).toBe(true)
  expect(equal(criteria, JSON.parse(JSON.stringify(criteria)))).toBe(true)
  const original = criteria[0].check
  if (original?.kind !== "byte-equality") throw new Error("Equality fixture required")
  for (const source of [
    { ...original.source, path: "relative" },
    { ...original.source, canonical: "relative" },
    { ...original.source, sha256: "A".repeat(64) },
    { ...original.source, bytes: -1 },
    { ...original.source, bytes: 1.5 },
    { ...original.source, bytes: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(valid([{ ...criteria[0], check: { ...original, source } }])).toBe(false)
  for (const source of [
    { ...original.source, path: "C:/other" },
    { ...original.source, canonical: "C:/other" },
    { ...original.source, sha256: "b".repeat(64) },
    { ...original.source, bytes: 49 },
  ])
    expect(equal(criteria, [{ ...criteria[0], check: { ...original, source } }])).toBe(false)
  for (const target of [
    { ...original.target, path: "C:/other" },
    { ...original.target, canonical: "C:/other" },
  ])
    expect(equal(criteria, [{ ...criteria[0], check: { ...original, target } }])).toBe(false)
  expect(valid([{ ...criteria[0], check: { ...original, target: { ...original.target, path: "relative" } } }])).toBe(
    false,
  )
  expect(valid([{ ...criteria[0], check: { ...original, extra: true } }])).toBe(false)
  expect(valid([{ ...criteria[0], check: { kind: "command", command: "bun test", directory: "C:/work" } }])).toBe(true)
})

test("actual SDK goal edit roundtrips equality and rejects changed source acknowledgement", async () => {
  const calls: Request[] = []
  const messages: unknown[] = []
  const returned = structuredClone(criteria)
  const client = createKiloClient({
    baseUrl: "http://localhost:4096",
    fetch: async (input, init) => {
      calls.push(new Request(input, init))
      return Response.json({
        objective: "Copy exactly",
        status: "paused",
        intent: "saved",
        createdAt: 1,
        updatedAt: 2,
        usage: { turns: 0, toolCalls: 0, continuations: 0 },
        progress: [],
        criteria: returned,
      })
    },
  })
  const context = {
    client,
    authorize: async () => () => true,
    message: {
      type: "goalEdit" as const,
      sessionID: "session",
      requestID: "equal",
      objective: "Copy exactly",
      expectedIntent: "original",
      criteria,
    },
    post: (value: unknown) => messages.push(value),
  }
  await editGoal(context)
  expect(await calls[0].json()).toMatchObject({ criteria, expectedIntent: "original" })
  expect(messages.at(-1)).toMatchObject({ goal: { criteria } })
  const check = returned[0].check
  if (check?.kind !== "byte-equality") throw new Error("Equality fixture required")
  check.source.bytes = 49
  await editGoal(context)
  expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("did not match") })
  const text = report({
    objective: "Copy exactly",
    status: "paused",
    createdAt: 1,
    updatedAt: 2,
    usage: { turns: 0, toolCalls: 0, continuations: 0 },
    progress: [],
    criteria,
  })
  expect(text).toContain("Saved exact byte-equality check")
  expect(text).toContain("Source bytes: 48")
  expect(text).toContain("Target: C:/work/result.txt")
  expect(text).not.toContain("undefined")
})

test("actual mounted editor preserves saved equality through descriptive edits", () => {
  const child = Bun.spawnSync(["bun", "--conditions=browser", "tests/fixtures/goal-byte-equality-view.mjs"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0)
}, 60000)
