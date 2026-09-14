import { expect, test } from "bun:test"
import { pricing, prompt, valid } from "../../src/kilocode/voice/live-protocol"

const user = {
  id: "frag_user_1",
  speaker: "user" as const,
  text: "Why did expenses increase?",
  start: 0,
  end: 800,
  sequence: 1,
}

function sample(
  fragments: Array<{
    id: string
    speaker: "user" | "assistant"
    text: string
    start: number
    end: number
    sequence: number
    client?: string
  }>,
) {
  return {
    generation: "req_live_1",
    context: {
      version: 1 as const,
      delegation: "dlg_live_1",
      offset: 1200,
      fragments,
      incomplete: true as const,
      omitted: false,
    },
  }
}

test("live context requires fresh user evidence without client correlation", () => {
  expect(valid(sample([user]))).toBe(true)
  expect(valid(sample([{ ...user, client: "cmd_1" }]))).toBe(false)
  expect(valid(sample([{ ...user, speaker: "assistant", text: "Generated speech" }]))).toBe(false)
})

test("live context rejects duplicate identities, inverted time and late starts", () => {
  expect(valid(sample([user, { ...user, id: "frag_user_1", sequence: 2 }]))).toBe(false)
  expect(valid(sample([user, { ...user, id: "frag_user_2", sequence: 1 }]))).toBe(false)
  expect(valid(sample([{ ...user, end: 10, start: 20 }]))).toBe(false)
  expect(valid(sample([{ ...user, start: 1201 }]))).toBe(false)
})

test("live prompt labels transcript uncertainty and does not treat captions as heard speech", () => {
  const text = prompt(sample([user]))
  expect(text.startsWith("Handle the user's current spoken request in this existing task.")).toBe(true)
  expect(text).toContain("not proof of heard assistant speech")
  expect(text).toContain("Earlier assistant text may be generated but unheard")
  expect(text).toContain(user.text)
  expect(text).toContain('"incomplete":true')
})

test("live duration pricing uses the published per-second GPT-Live rate", () => {
  expect(pricing({ id: "duration_zero", model: "gpt-live-1", seconds: 0 })).toEqual({
    amount: 0,
    currency: "USD",
    quantity: 0,
    unit: "seconds",
    source: "openai-model-doc:gpt-live-1:2026-09-14",
  })
  expect(pricing({ id: "duration_partial", model: "gpt-live-1", seconds: 6 })).toMatchObject({
    amount: 0.005,
    quantity: 6,
  })
  expect(pricing({ id: "duration_limit", model: "gpt-live-1", seconds: 86_400 })).toMatchObject({
    amount: 72,
    quantity: 86_400,
  })
})
