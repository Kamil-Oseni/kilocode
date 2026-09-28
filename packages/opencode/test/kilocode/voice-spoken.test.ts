import { expect, test } from "bun:test"
import * as Spoken from "@/kilocode/voice/openai-spoken"

const input: typeof Spoken.Input.Type = {
  generation: "generation",
  providerCallID: "provider",
  version: 1,
  revision: 1,
  items: [
    { id: "one", previous: null, role: "user", state: "final", text: "Violin" },
    { id: "two", previous: "one", role: "assistant", state: "pending" },
    { id: "three", previous: "two", role: "user", state: "final", text: "500 CAD" },
  ],
}
const snapshot: typeof Spoken.Snapshot.Type = {
  version: 1,
  revision: 1,
  updatedAt: 1,
  incomplete: false,
  items: input.items,
}

test("spoken validation bounds Unicode bytes, total payload, identities and final-text classifications", () => {
  expect(Spoken.valid(input)).toBe(true)
  for (const value of [
    { ...input, updatedAt: 2 },
    { ...input, items: [input.items[0]!, input.items[0]!] },
    { ...input, items: [{ ...input.items[0]!, text: "😀".repeat(1025) }] },
    { ...input, items: [{ ...input.items[1]!, text: "generated" }] },
    { ...input, items: [{ ...input.items[0]!, state: "omitted" as const }] },
    { ...input, items: [{ ...input.items[0]!, role: "other" as const }] },
    { ...input, items: Array.from({ length: 129 }, (_, index) => ({ ...input.items[0]!, id: `i${index}` })) },
    {
      ...input,
      items: Array.from({ length: 9 }, (_, index) => ({ ...input.items[0]!, id: `i${index}`, text: "x".repeat(4096) })),
    },
  ])
    expect(Spoken.valid(value)).toBe(false)
})

test("linked conversation order survives completion order and truthfully exposes gaps, cycles and branching", () => {
  expect(
    Spoken.ordered({ ...snapshot, items: [input.items[2]!, input.items[0]!, input.items[1]!] }).items.map(
      (item) => item.id,
    ),
  ).toEqual(["one", "two", "three"])
  expect(Spoken.ordered(snapshot).incomplete).toBe(false)
  expect(Spoken.ordered({ ...snapshot, incomplete: true, items: input.items.slice(1) }).incomplete).toBe(true)
  expect(
    Spoken.ordered({ ...snapshot, items: [{ ...input.items[0]!, previous: "three" }, ...input.items.slice(1)] }),
  ).toEqual({ items: [], incomplete: true })
  expect(
    Spoken.ordered({ ...snapshot, items: [...input.items, { ...input.items[2]!, id: "branch", previous: "one" }] })
      .incomplete,
  ).toBe(true)
})

test("monotone full snapshots preserve known omissions and permit only disclosed prefix eviction", () => {
  const final = {
    ...snapshot,
    items: input.items.map((item) =>
      item.id === "two" ? { ...item, state: "final" as const, text: "A generated answer" } : item,
    ),
  }
  expect(Spoken.follows(snapshot, final)).toBe(true)
  const omitted = {
    ...snapshot,
    items: input.items.map((item) => (item.id === "two" ? { ...item, state: "omitted" as const } : item)),
  }
  expect(Spoken.follows(final, omitted)).toBe(true)
  expect(Spoken.follows(omitted, final)).toBe(false)
  const deleted = {
    ...snapshot,
    incomplete: true,
    items: snapshot.items.map((item) =>
      item.id === "one" ? { id: item.id, previous: item.previous, role: item.role, state: "omitted" as const } : item,
    ),
  }
  expect(Spoken.valid({ ...input, items: deleted.items, incomplete: true })).toBe(true)
  expect(Spoken.follows(snapshot, deleted)).toBe(true)
  expect(Spoken.follows(deleted, snapshot)).toBe(false)
  expect(
    Spoken.follows(deleted, {
      ...snapshot,
      items: [{ ...input.items[0]!, text: "replacement" }, ...input.items.slice(1)],
    }),
  ).toBe(false)
  expect(Spoken.follows(snapshot, { ...snapshot, items: [input.items[0]!, input.items[2]!], incomplete: true })).toBe(
    false,
  )
  expect(Spoken.follows(snapshot, { ...snapshot, items: input.items.slice(1) })).toBe(false)
  expect(Spoken.follows(snapshot, { ...snapshot, items: input.items.slice(1), incomplete: true })).toBe(true)
  expect(Spoken.follows(snapshot, { ...snapshot, items: [input.items[1]!, input.items[0]!, input.items[2]!] })).toBe(
    false,
  )
  expect(
    Spoken.follows(snapshot, {
      ...snapshot,
      items: [{ ...input.items[0]!, text: "changed" }, ...input.items.slice(1)],
    }),
  ).toBe(false)
  expect(Spoken.follows(snapshot, { ...snapshot, incomplete: true, items: [] })).toBe(true)
  expect(
    Spoken.follows(snapshot, { ...snapshot, items: input.items.map((item) => ({ ...item, role: "other" as const })) }),
  ).toBe(false)
})
