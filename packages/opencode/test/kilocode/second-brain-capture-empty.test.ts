import { expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { asSchema, generateText, Output } from "ai"
import { extraction, extracted, prepared } from "../../src/kilocode/second-brain/capture-extraction"
import { entries } from "../../src/kilocode/second-brain/capture-source"

const source = {
  user: {
    id: "msg_original_user",
    text: "For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms. I also prefer the Memory tab to be for manually inspecting and adjusting settings. Do not change lights or place orders.",
  },
  assistant: { id: "msg_original_assistant", text: "Understood." },
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

test("empty general capture entries have an explicit zero bound without an impossible item grammar", async () => {
  const current = asSchema(extraction(source, true))
  const schema = await current.jsonSchema
  expect(source.user.text.length).toBe(215)
  expect(JSON.stringify(schema)).not.toContain('"not"')
  expect(schema).toMatchObject({ properties: { entries: { maxItems: 0 } } })
  expect((await current.validate!(output)).success).toBe(true)
  expect(entries(extracted(output, source, true), source)).toHaveLength(2)
  const refs = JSON.parse(prepared(source, true))
  expect(
    refs.filter((row: { excluded?: string }) => row.excluded).map((row: { excluded: string }) => row.excluded),
  ).toEqual(["temporary_action_restriction", "preference_acknowledgement"])
})

test("actual empty capture schema passes valid preference slots through the SDK and rejects excluded references", async () => {
  const requests: Record<string, unknown>[] = []
  let content = JSON.stringify(output)
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      requests.push(await request.json())
      return Response.json({
        id: "capture-fixture",
        object: "chat.completion",
        created: 0,
        model: "controlled-provider",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 32, completion_tokens: 64, total_tokens: 96 },
      })
    },
  })
  try {
    const candidate = extraction(source, true)
    const sdk = createOpenAICompatible({
      name: "controlled-provider",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      supportsStructuredOutputs: true,
    })
    const run = (schema = candidate) =>
      generateText({
        model: sdk.languageModel("controlled-provider"),
        prompt: prepared(source, true),
        output: Output.object({ schema, name: "personal_capture" }),
        maxRetries: 0,
      })
    const accepted = await run()
    expect(entries(extracted(accepted.output, source, true), source).map((row) => row.key)).toEqual([
      "p0_ask_cards",
      "p2_manual_memory",
    ])
    expect(requests[0]).toMatchObject({
      response_format: { type: "json_schema", json_schema: { schema: { properties: { entries: { maxItems: 0 } } } } },
    })
    for (const value of [
      { ...output, entries: [cards] },
      { ...output, entries: [{ ...cards, origin: "assistant_interpretation", evidence: [{ ref: 4 }] }] },
      { ...output, entries: [{ ...cards, evidence: [{ ref: 3 }] }] },
      { ...output, preferences: { ...output.preferences, preference_2: { status: "retained", entry: cards } } },
    ]) {
      content = JSON.stringify(value)
      const invalid = await run().then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(invalid).toBeInstanceOf(Error)
      expect(invalid instanceof Error && invalid.message).toContain("No object generated")
    }
    expect(requests).toHaveLength(5)
  } finally {
    await server.stop(true)
  }
})
