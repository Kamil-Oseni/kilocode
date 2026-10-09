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
    expect(parsed[0].key).toBe("ask_cards")
  }
  expect(() =>
    extracted(
      { ...output, preferences: { ...output.preferences, preference_2: { status: "excluded", reason: "forgot" } } },
      original,
    ),
  ).toThrow()
  for (const key of ["health", "ask_cards"]) {
    const parsed = extracted(
      {
        ...output,
        preferences: { ...output.preferences, preference_2: { status: "retained", entry: { ...memory, key } } },
      },
      original,
    )
    expect(() => entries(parsed, original)).toThrow("duplicate or restricted")
  }
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
