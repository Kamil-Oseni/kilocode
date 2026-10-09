import { expect, test } from "bun:test"
import { asSchema } from "ai"
import { extracted, extraction, prepared } from "../../src/kilocode/second-brain/capture-extraction"
import { entries } from "../../src/kilocode/second-brain/capture-source"

const first = "For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms."
const second = "I also prefer the Memory tab to be for manually inspecting and adjusting settings."
const original = {
  user: { id: "msg_user", text: `${first} ${second} Do not change lights or place orders.` },
  assistant: { id: "msg_assistant", text: "Concise ask cards and manual Memory settings for Raya." },
  tools: [],
}
const cards = {
  category: "Preferences",
  key: "ask_cards",
  text: "Prefers concise conversational ask cards instead of lengthy forms for first-time Raya setup.",
  origin: "user_statement",
  evidence: [{ ref: 0 }],
}
const memory = {
  ...cards,
  key: "manual_memory",
  text: "Prefers the Memory tab for manually inspecting and adjusting settings.",
  evidence: [{ ref: 2 }],
}
const output = {
  entries: [],
  preferences: {
    preference_0: { status: "retained", entry: cards },
    preference_2: { status: "retained", entry: memory },
  },
}

test("compound preference slots bind independent original sentence spans", () => {
  const blocks = JSON.parse(prepared(original))
  expect(blocks.filter((row: { slot?: string }) => row.slot)).toEqual([
    { ...original.user, text: first, origin: "user_statement", ref: 0, slot: "preference_0" },
    { ...original.user, text: second, origin: "user_statement", ref: 2, slot: "preference_2" },
  ])
  const parsed = entries(extracted(output, original), original)
  expect(parsed).toHaveLength(2)
  expect(parsed[0].evidence).toEqual([{ id: "msg_user", start: 0, end: first.length }])
  expect(parsed[1].evidence).toEqual([
    { id: "msg_user", start: first.length + 1, end: first.length + 1 + second.length },
  ])
  expect(original.user.text.slice(parsed[1].evidence[0].start, parsed[1].evidence[0].end)).toBe(second)
})

test("native contract requires every slot and keeps general and preference bounds", async () => {
  const schema = await asSchema(extraction(original)).jsonSchema
  expect(schema).toMatchObject({
    additionalProperties: false,
    required: ["entries", "preferences"],
    properties: {
      entries: { maxItems: 6 },
      preferences: { additionalProperties: false, required: ["preference_0", "preference_2"] },
    },
  })
  expect(JSON.stringify(schema)).not.toContain('"allOf"')
  for (const value of [
    { entries: [cards] },
    { entries: [], preferences: { preference_0: output.preferences.preference_0 } },
    { ...output, preferences: { ...output.preferences, invented: output.preferences.preference_0 } },
    { ...output, entries: [cards] },
    { ...output, entries: [{ ...cards, evidence: [{ ref: 1 }] }] },
    { ...output, entries: [{ ...cards, evidence: [{ ref: 4 }] }] },
    { ...output, entries: [{ ...cards, origin: "assistant_interpretation", evidence: [{ ref: 3 }] }] },
    { ...output, preferences: { ...output.preferences, preference_2: { status: "retained", entry: cards } } },
    {
      ...output,
      preferences: {
        ...output.preferences,
        preference_2: { status: "retained", entry: { ...memory, origin: "assistant_interpretation" } },
      },
    },
    {
      ...output,
      preferences: {
        ...output.preferences,
        preference_2: { status: "retained", entry: { ...memory, evidence: [{ ref: 2 }, { ref: 0 }] } },
      },
    },
  ])
    expect(() => extracted(value, original)).toThrow("bounded entry schema")
  const other = { ...cards, origin: "assistant_interpretation", evidence: [{ ref: 4 }] }
  expect(
    entries(extracted({ ...output, entries: [{ ...other, key: "assistant_summary" }] }, original), original),
  ).toHaveLength(3)
  expect(() =>
    extracted(
      { ...output, entries: Array.from({ length: 7 }, (_, index) => ({ ...other, key: `other_${index}` })) },
      original,
    ),
  ).toThrow()
})

test("explicit exclusions retain no fallback facts and restricted or duplicate entries still fail", () => {
  for (const reason of ["sensitive", "transient", "no_durable_fact"]) {
    const parsed = entries(
      extracted(
        { ...output, preferences: { ...output.preferences, preference_2: { status: "excluded", reason } } },
        original,
      ),
      original,
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0].key).toBe("p0_ask_cards")
  }
  expect(() =>
    extracted(
      { ...output, preferences: { ...output.preferences, preference_2: { status: "excluded", reason: "forgot" } } },
      original,
    ),
  ).toThrow()
  for (const key of ["health", "private_health"]) {
    expect(() =>
      extracted(
        {
          ...output,
          preferences: { ...output.preferences, preference_2: { status: "retained", entry: { ...memory, key } } },
        },
        original,
      ),
    ).toThrow("restricted_key")
  }
  const equal = entries(
    extracted(
      {
        ...output,
        preferences: {
          ...output.preferences,
          preference_2: { status: "retained", entry: { ...memory, key: cards.key } },
        },
      },
      original,
    ),
    original,
  )
  expect(equal.map((entry) => entry.key)).toEqual(["p0_ask_cards", "p2_ask_cards"])
  expect(equal.map((entry) => entry.text)).toEqual([cards.text, memory.text])
  const other = { ...cards, origin: "assistant_interpretation", evidence: [{ ref: 4 }] }
  expect(() => entries(extracted({ ...output, entries: [other, other] }, original), original)).toThrow("duplicate_key")
})

test("temporary command refs cannot publish duplicate preferences and other durable preferences remain available", async () => {
  const rows = JSON.parse(prepared(original)) as { ref: number; text: string; excluded?: string }[]
  const tail = rows.find((row) => row.text.includes("Do not change lights"))!
  expect(tail.excluded).toBe("temporary_action_restriction")
  const schema = await asSchema(extraction(original)).jsonSchema
  const validate = asSchema(extraction(original)).validate!
  for (const entry of [
    { ...cards, evidence: [{ ref: tail.ref }] },
    { ...memory, evidence: [{ ref: tail.ref }] },
    { ...cards, key: "no_auto_actions", text: "Do not change lights or place orders.", evidence: [{ ref: tail.ref }] },
    { ...cards, category: "Decisions", evidence: [{ ref: tail.ref }] },
  ]) {
    expect((await validate({ ...output, entries: [entry] })).success).toBe(false)
    expect(() => extracted({ ...output, entries: [entry] }, original)).toThrow("bounded entry schema")
  }
  expect(schema).toBeDefined()
  expect(entries(extracted(output, original), original).map((entry) => entry.text)).toEqual([cards.text, memory.text])
  const source = {
    ...original,
    user: { ...original.user, text: `${original.user.text} My current project is Garden.` },
  }
  const project = (JSON.parse(prepared(source)) as { ref: number; text: string }[]).find((row) =>
    row.text.includes("My current project"),
  )!
  const parsed = entries(
    extracted(
      {
        ...output,
        entries: [
          {
            ...cards,
            category: "Projects",
            key: "garden",
            text: "Current project is Garden.",
            evidence: [{ ref: project.ref }],
          },
        ],
      },
      source,
    ),
    source,
  )
  expect(parsed).toHaveLength(3)
  expect(source.user.text.slice(parsed[0].evidence[0].start, parsed[0].evidence[0].end).trim()).toBe(
    "My current project is Garden.",
  )
  const third = {
    ...original,
    user: { ...original.user, text: `${original.user.text} My preference is quiet replies.` },
  }
  const ref = (JSON.parse(prepared(third)) as { ref: number; text: string }[]).find((row) =>
    row.text.includes("My preference is quiet"),
  )!.ref
  expect(
    entries(
      extracted(
        { ...output, entries: [{ ...cards, key: "quiet", text: "Prefers quiet replies.", evidence: [{ ref }] }] },
        third,
      ),
      third,
    )[0].text,
  ).toBe("Prefers quiet replies.")
})

test("host prefixes preserve complete bounded suffixes and secret restrictions", () => {
  const key = "a".repeat(77)
  const value = {
    ...output,
    preferences: { ...output.preferences, preference_0: { status: "retained", entry: { ...cards, key } } },
  }
  expect(entries(extracted(value, original), original)[0].key).toBe(`p0_${key}`)
  expect(() =>
    extracted(
      {
        ...value,
        preferences: {
          ...value.preferences,
          preference_0: { status: "retained", entry: { ...cards, key: "a".repeat(78) } },
        },
      },
      original,
    ),
  ).toThrow("bounded entry schema")
  expect(() =>
    extracted(
      {
        ...output,
        preferences: {
          ...output.preferences,
          preference_0: {
            status: "retained",
            entry: { ...cards, text: "git clone https://alice:password@example.com/repo" },
          },
        },
      },
      original,
    ),
  ).toThrow("secret_text")
})

test("bounded clause segmentation preserves Unicode and leaves other extraction contracts unchanged", () => {
  const unicode = { ...original, user: { id: "msg_user", text: "I like 😀 icons. I dislike lengthy forms." } }
  const parsed = extracted(
    {
      ...output,
      preferences: {
        preference_0: { status: "retained", entry: { ...cards, text: "Likes 😀 icons." } },
        preference_2: { status: "retained", entry: { ...memory, text: "Dislikes lengthy forms." } },
      },
    },
    unicode,
  )
  expect(parsed[0].evidence[0]).toEqual({ id: "msg_user", start: 0, end: "I like 😀 icons.".length })
  for (const text of [first, "I prefer quiet replies. ".repeat(5), "a".repeat(1001) + first + second]) {
    const source = { ...original, user: { id: "msg_user", text } }
    expect(JSON.parse(prepared(source)).some((row: { slot?: string }) => row.slot)).toBe(false)
    expect(extracted({ entries: [] }, source)).toEqual([])
  }
})

test("general references admit only nonblank blocks of their own original origin", () => {
  const source = {
    ...original,
    user: { id: "msg_user", text: first },
    tools: [
      { id: "prt_completed", name: "read", status: "completed" as const, text: "Observed file contents." },
      { id: "prt_error", name: "read", status: "error" as const, text: "File unavailable." },
    ],
  }
  const tool = { ...cards, key: "tool_observation", origin: "tool_observation", evidence: [{ ref: 2 }, { ref: 3 }] }
  expect(entries(extracted({ entries: [tool] }, source), source)[0].evidence).toEqual([
    { id: "prt_completed", start: 0, end: 23 },
    { id: "prt_error", start: 0, end: 17 },
  ])
  for (const entry of [
    { ...cards, evidence: [{ ref: 1 }] },
    { ...tool, evidence: [{ ref: 0 }] },
    { ...tool, evidence: [{ ref: 2 }, { ref: 1 }] },
    { ...cards, origin: "assistant_interpretation", evidence: [{ ref: 2 }] },
  ])
    expect(() => extracted({ entries: [entry] }, source)).toThrow("bounded entry schema")
  const blank = { user: { id: "msg_user", text: " " }, assistant: { id: "msg_assistant", text: "\n" }, tools: [] }
  expect(extracted({ entries: [] }, blank)).toEqual([])
  expect(() => extracted({ entries: [cards] }, blank)).toThrow("bounded entry schema")
})
