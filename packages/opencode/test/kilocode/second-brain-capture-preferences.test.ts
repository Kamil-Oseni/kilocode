import { expect, test } from "bun:test"
import { asSchema } from "ai"
import { Schema } from "effect"
import { extracted, extraction, prepared } from "../../src/kilocode/second-brain/capture-extraction"
import { entries } from "../../src/kilocode/second-brain/capture-source"

function references(text: string) {
  return Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        ref: Schema.Int,
        text: Schema.String,
        excluded: Schema.optional(Schema.String),
        origin: Schema.optional(Schema.String),
        slot: Schema.optional(Schema.String),
      }),
    ),
  )(JSON.parse(text))
}

const first = "For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms."
const second = "I also prefer the Memory tab to be for manually inspecting and adjusting settings."
const original = {
  user: { id: "msg_user", text: `${first} ${second} Do not change lights or place orders.` },
  assistant: { id: "msg_assistant", text: "Concise ask cards and manual Memory settings for Raya." },
  tools: [],
}
const cards = {
  category: "Preferences" as const,
  key: "ask_cards",
  text: "Prefers concise conversational ask cards instead of lengthy forms for first-time Raya setup.",
  origin: "user_statement" as const,
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

test("acknowledged natural grocery originals accept valid extraction without assistant attribution", async () => {
  // Parser acceptance does not guarantee that a model will choose to extract a memory.
  for (const text of [
    "I prefer Raya to keep track of missing groceries and maintain my shopping list.",
    "For grocery shopping, I prefer Raya to keep track of missing groceries and maintain my shopping list.",
    "SecondBrain should help me remember groceries I lack and keep a list to buy.",
  ]) {
    const source = {
      user: { id: "msg_user", text },
      assistant: {
        id: "msg_assistant",
        text: "Understood: I can help track missing groceries and your shopping list.",
      },
      tools: [],
    }
    const entry = { ...cards, key: "grocery_support", text, evidence: [{ ref: 0 }] }
    const slotted = text.startsWith("I prefer") || text.startsWith("For grocery shopping, I prefer")
    const value = slotted
      ? { entries: [], preferences: { preference_0: { status: "retained", entry } } }
      : { entries: [entry] }
    expect((await asSchema(extraction(source, true)).validate!(value)).success).toBe(true)
    expect(entries(extracted(value, source, true), source)).toEqual([
      {
        category: "Preferences",
        key: slotted ? `p0_${entry.key}` : entry.key,
        text: slotted ? `${text}\n\nOriginal user preference: ${text}` : text,
        origin: "user_statement",
        evidence: [{ id: source.user.id, start: 0, end: text.length }],
      },
    ])
    const excluded = slotted
      ? { entries: [], preferences: { preference_0: { status: "excluded", reason: "no_durable_fact" } } }
      : { entries: [] }
    expect(extracted(excluded, source, true)).toEqual([])
    for (const candidate of [
      { ...entry, evidence: [{ ref: 1 }] },
      { ...entry, origin: "assistant_interpretation", evidence: [{ ref: 1 }] },
    ]) {
      const invalid = slotted
        ? { entries: [], preferences: { preference_0: { status: "retained", entry: candidate } } }
        : { entries: [candidate] }
      expect((await asSchema(extraction(source, true)).validate!(invalid)).success).toBe(false)
      expect(() => extracted(invalid, source, true)).toThrow("bounded entry schema")
    }
  }
})

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
  expect(equal.map((entry) => entry.text)).toEqual([
    `${cards.text}\n\nOriginal user preference: ${first}`,
    `${memory.text}\n\nOriginal user preference: ${second}`,
  ])
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
  expect(entries(extracted(output, original), original).map((entry) => entry.text)).toEqual([
    `${cards.text}\n\nOriginal user preference: ${first}`,
    `${memory.text}\n\nOriginal user preference: ${second}`,
  ])
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
  const ref = references(prepared(third)).find((row) => row.text.includes("My preference is quiet"))!.ref
  const quiet = { ...cards, key: "quiet", text: "Prefers quiet replies.", evidence: [{ ref }] }
  const value = {
    ...output,
    preferences: { ...output.preferences, [`preference_${ref}`]: { status: "retained", entry: quiet } },
  }
  const retained = entries(extracted(value, third), third)
  expect(retained).toHaveLength(3)
  expect(retained[2]).toEqual({
    ...quiet,
    key: `p${ref}_quiet`,
    text: "Prefers quiet replies.\n\nOriginal user preference: My preference is quiet replies.",
    evidence: [{ id: third.user.id, start: original.user.text.length + 1, end: third.user.text.length }],
  })
  expect(third.user.text.slice(retained[2].evidence[0].start, retained[2].evidence[0].end)).toBe(
    "My preference is quiet replies.",
  )
  expect(() => extracted({ ...output, entries: [quiet] }, third)).toThrow("bounded entry schema")
  expect(() => extracted({ ...value, entries: [quiet] }, third)).toThrow("bounded entry schema")
})

test("original voice preference survives while acknowledgement-only references cannot create extra facts", async () => {
  const text =
    "I prefer turn-taking voice without automatic interruption: let me finish speaking, wait for Raya to finish its reply, then accept the next turn. Please just acknowledge this preference."
  const source = {
    ...original,
    user: { id: "msg_user", text },
    assistant: { id: "msg_assistant", text: "Understood." },
  }
  expect(text).toHaveLength(185)
  const rows = references(prepared(source, true))
  const request = rows.find((row) => row.text === "Please just acknowledge this preference.")!
  expect(request.excluded).toBe("acknowledgement_request")
  const entry = { ...cards, key: "turn_taking", text: "Prefers turn-taking voice without automatic interruption." }
  const value = { entries: [], preferences: { preference_0: { status: "retained", entry } } }
  const schema = asSchema(extraction(source, true))
  expect(await schema.jsonSchema).toMatchObject({ properties: { entries: { maxItems: 0 } } })
  expect((await schema.validate!(value)).success).toBe(true)
  const parsed = entries(extracted(value, source, true), source)
  expect(parsed).toHaveLength(1)
  expect(parsed[0].evidence).toEqual([{ id: "msg_user", start: 0, end: 144 }])
  expect(parsed[0].text).toBe(`${entry.text}\n\nOriginal user preference: ${text.slice(0, 144)}`)
  for (const key of ["turn_taking_voice", "preference_acknowledgement"]) {
    const invalid = { ...value, entries: [{ ...entry, key, evidence: [{ ref: request.ref }] }] }
    expect((await schema.validate!(invalid)).success).toBe(false)
    expect(() => extracted(invalid, source, true)).toThrow("bounded entry schema")
  }
  const invalid = {
    ...value,
    preferences: { preference_0: { status: "retained", entry: { ...entry, evidence: [{ ref: request.ref }] } } },
  }
  expect((await schema.validate!(invalid)).success).toBe(false)
  expect(() => extracted(invalid, source, true)).toThrow("bounded entry schema")
})

test("pure acknowledgement requests admit zero facts through the actual capture schema", async () => {
  for (const text of [
    "Please just acknowledge this preference.",
    "Acknowledge my preference.",
    "Just acknowledge that.",
  ]) {
    const source = {
      ...original,
      user: { id: "msg_user", text },
      assistant: { id: "msg_assistant", text: "Understood." },
    }
    const schema = asSchema(extraction(source, true))
    expect(await schema.jsonSchema).toMatchObject({ properties: { entries: { maxItems: 0 } } })
    expect(extracted({ entries: [] }, source, true)).toEqual([])
    const invalid = { entries: [{ ...cards, evidence: [{ ref: 0 }] }] }
    expect((await schema.validate!(invalid)).success).toBe(false)
    expect(() => extracted(invalid, source, true)).toThrow("bounded entry schema")
  }
})

test("acknowledgement segmentation preserves mixed durable facts and lasting acknowledgement preferences", async () => {
  const source = {
    ...original,
    user: { id: "msg_user", text: "Please acknowledge this preference. My current project is Garden." },
  }
  const rows = references(prepared(source, true))
  const project = rows.find((row) => row.text.includes("My current project"))!
  const value = {
    entries: [
      {
        ...cards,
        category: "Projects",
        key: "garden",
        text: "Current project is Garden.",
        evidence: [{ ref: project.ref }],
      },
    ],
  }
  expect((await asSchema(extraction(source, true)).validate!(value)).success).toBe(true)
  const parsed = entries(extracted(value, source, true), source)
  expect(source.user.text.slice(parsed[0].evidence[0].start, parsed[0].evidence[0].end)).toBe(
    " My current project is Garden.",
  )
  const lasting = {
    ...source,
    user: { id: "msg_user", text: "I prefer brief acknowledgements instead of lengthy explanations." },
  }
  const preference = {
    entries: [],
    preferences: {
      preference_0: {
        status: "retained",
        entry: { ...cards, text: "Prefers brief acknowledgements instead of lengthy explanations." },
      },
    },
  }
  expect((await asSchema(extraction(lasting, true)).validate!(preference)).success).toBe(true)
  expect(entries(extracted(preference, lasting, true), lasting)[0].evidence).toEqual([
    { id: "msg_user", start: 0, end: lasting.user.text.length },
  ])
  const imperative = { ...source, user: { id: "msg_user", text: "Remember my current project is Garden." } }
  expect(extracted({ entries: [{ ...value.entries[0], evidence: [{ ref: 0 }] }] }, imperative, true)).toHaveLength(1)
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
  expect(parsed.map((entry) => entry.text)).toEqual([
    "Likes 😀 icons.\n\nOriginal user preference: I like 😀 icons.",
    "Dislikes lengthy forms.\n\nOriginal user preference: I dislike lengthy forms.",
  ])
  for (const text of ["I prefer quiet replies. ".repeat(5), "a".repeat(1001) + first + second]) {
    const source = { ...original, user: { id: "msg_user", text } }
    expect(JSON.parse(prepared(source)).some((row: { slot?: string }) => row.slot)).toBe(false)
    expect(extracted({ entries: [] }, source)).toEqual([])
  }
})

test("general references admit only nonblank blocks of their own original origin", () => {
  const source = {
    ...original,
    user: { id: "msg_user", text: "My setup uses conversational ask cards." },
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
  expect(entries(extracted({ entries: [tool] }, source), source)[0].text).toBe(tool.text)
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

test("truncated retained summaries preserve both exact user preference clauses without excluded context", () => {
  const source = { ...original, assistant: { id: "msg_assistant", text: "Understood." } }
  const value = {
    ...output,
    preferences: {
      preference_0: { status: "retained", entry: { ...cards, text: "Prefers concise ask cards." } },
      preference_2: { status: "retained", entry: { ...memory, text: "Prefers the Memory tab." } },
    },
  }
  const parsed = entries(extracted(value, source, true), source)
  expect(parsed.map((entry) => entry.text)).toEqual([
    `Prefers concise ask cards.\n\nOriginal user preference: ${first}`,
    `Prefers the Memory tab.\n\nOriginal user preference: ${second}`,
  ])
  expect(parsed).toHaveLength(2)
  expect(parsed.map((entry) => entry.evidence)).toEqual([
    [{ id: "msg_user", start: 0, end: first.length }],
    [{ id: "msg_user", start: first.length + 1, end: first.length + 1 + second.length }],
  ])
  expect(parsed.map((entry) => entry.text).join("\n")).not.toContain("Understood.")
  expect(parsed.map((entry) => entry.text).join("\n")).not.toContain("Do not change lights or place orders.")
})

test("excluded preference dispositions never receive original-clause fallback", () => {
  for (const reason of ["sensitive", "transient", "no_durable_fact"]) {
    const value = {
      ...output,
      preferences: {
        preference_0: { status: "excluded", reason },
        preference_2: output.preferences.preference_2,
      },
    }
    const parsed = entries(extracted(value, original, true), original)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].text).toBe(`${memory.text}\n\nOriginal user preference: ${second}`)
    expect(parsed[0].text).not.toContain(first)
  }
})

test("original-clause augmentation rejects original secrets and oversized completed text", () => {
  const source = { ...original, user: { id: "msg_user", text: `I prefer using password=hunterx. ${second}` } }
  expect(() => extracted(output, source, true)).toThrow("secret_text")
  const excluded = {
    ...output,
    preferences: { ...output.preferences, preference_0: { status: "excluded", reason: "sensitive" } },
  }
  expect(entries(extracted(excluded, source, true), source)).toHaveLength(1)
  const oversized = {
    ...output,
    preferences: {
      ...output.preferences,
      preference_0: { status: "retained", entry: { ...cards, text: "q".repeat(4096) } },
    },
  }
  expect(() => extracted(oversized, original, true)).toThrow("bounded entry schema")
  const multibyte = {
    ...oversized,
    preferences: {
      ...oversized.preferences,
      preference_0: { status: "retained", entry: { ...cards, text: "界".repeat(1340) } },
    },
  }
  expect(() => extracted(multibyte, original, true)).toThrow("bounded entry schema")
})

test("stated and saved voice acknowledgements require explicit original preference dispositions", async () => {
  for (const [fact, request] of [
    [
      "My stated voice preference is a turn-taking conversation without automatic interruption.",
      "Please just acknowledge that in one sentence.",
    ],
    [
      "My saved voice preference is turn-taking without automatic interruption: I finish speaking, Raya finishes its reply, then I take the next turn.",
      "Please acknowledge it in one sentence.",
    ],
    ["My speech preference is turn-taking without automatic interruption.", "Please acknowledge my preference."],
    ["My reply preference is turn-taking without automatic interruption!", "Please acknowledge that in one sentence."],
    ["My preference is turn-taking without automatic interruption.", "Please acknowledge it in one sentence."],
  ]) {
    const source = {
      user: { id: "msg_user", text: `${fact} ${request}` },
      assistant: { id: "msg_assistant", text: "Understood: you prefer turn-taking without automatic interruption." },
      tools: [],
    }
    const rows = references(prepared(source, true))
    const slot = rows.find((row) => row.slot)!
    const ack = rows.find((row) => row.text === request)!
    const reply = rows.find((row) => row.origin === "assistant_interpretation")!
    expect(slot).toMatchObject({ ref: 0, slot: "preference_0", text: fact, origin: "user_statement" })
    expect(ack.excluded).toBe("acknowledgement_request")
    expect(reply.excluded).toBe("preference_acknowledgement")
    const entry = { ...cards, key: "turn_taking", text: "Prefers turn-taking without automatic interruption." }
    const value = { entries: [], preferences: { preference_0: { status: "retained", entry } } }
    const validate = asSchema(extraction(source, true)).validate!
    expect((await validate(value)).success).toBe(true)
    const result = entries(extracted(value, source, true), source)
    expect(result).toEqual([
      {
        ...entry,
        key: "p0_turn_taking",
        text: `${entry.text}\n\nOriginal user preference: ${fact}`,
        evidence: [{ id: source.user.id, start: 0, end: fact.length }],
      },
    ])
    expect(source.user.text.slice(result[0].evidence[0].start, result[0].evidence[0].end)).toBe(fact)
    for (const reason of ["sensitive", "transient", "no_durable_fact"]) {
      const excluded = { entries: [], preferences: { preference_0: { status: "excluded", reason } } }
      expect((await validate(excluded)).success).toBe(true)
      expect(extracted(excluded, source, true)).toEqual([])
    }
    for (const invalid of [
      { entries: [] },
      { ...value, preferences: {} },
      { ...value, preferences: { ...value.preferences, preference_9: value.preferences.preference_0 } },
      { entries: [entry], preferences: { preference_0: { status: "excluded", reason: "transient" } } },
      ...[ack.ref, reply.ref].map((ref) => ({
        ...value,
        preferences: { preference_0: { status: "retained", entry: { ...entry, evidence: [{ ref }] } } },
      })),
      {
        ...value,
        preferences: { preference_0: { status: "retained", entry: { ...entry, origin: "assistant_interpretation" } } },
      },
    ]) {
      expect((await validate(invalid)).success).toBe(false)
      expect(() => extracted(invalid, source, true)).toThrow("bounded entry schema")
    }
  }
})

test("new My-preference slots require a fact and do not consume mixed imperative clauses", () => {
  for (const text of [
    "My stated voice preference is.",
    "My stated voice preference is turn-taking?",
    "My stated voice preference is turn-taking, is that correct?",
    "My stated voice preference is what I saved? Please acknowledge it in one sentence.",
    "My saved voice preference is .",
    "Tell me what my saved voice preference is.",
    "What is my stated voice preference?",
    ...[
      "recall",
      "retrieve",
      "remember",
      "search",
      "query",
      "tell",
      "remind",
      "save",
      "configure",
      "change",
      "control",
    ].map((action) => `My stated voice preference is turn-taking and ${action} my saved notes.`),
  ]) {
    const source = { user: { id: "msg_user", text }, assistant: { id: "msg_assistant", text: "Observed." }, tools: [] }
    expect(references(prepared(source, true)).some((row) => row.slot)).toBe(false)
  }
  const source = {
    user: {
      id: "msg_user",
      text: "My stated voice preference is turn-taking. Please acknowledge it and search my notes.",
    },
    assistant: { id: "msg_assistant", text: "Observed." },
    tools: [],
  }
  const rows = references(prepared(source, true))
  expect(rows.find((row) => row.slot)?.text).toBe("My stated voice preference is turn-taking.")
  expect(rows.find((row) => row.text.includes("Please acknowledge"))?.excluded).toBeUndefined()
})
