import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { context } from "@/kilocode/provider/ollama-context"

test("explicit context preserves the configured model window", () => {
  const options = { localInference: true, localInferenceAPI: "ollama", localInferenceContext: 65536 }
  expect(context(options, { api: { id: "fixture" }, limit: { context: 65536 } }).ollamaContext).toBe(65536)
  expect(context(options, { api: { id: "fixture" }, limit: { context: 0 } }).ollamaContext).toBe(65536)
  expect(() => context(options, { api: { id: "fixture" }, limit: { context: 32768 } })).toThrow(
    "Explicit local context differs from configured model window",
  )
  expect(() => ollama({ ...options, ollamaContext: 32768 }, fetch)).toThrow(OllamaBridgeError)
})

test("real HTTP forwards explicit context/residency and preserves refusal flags", async () => {
  const rows: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      rows.push(await request.json())
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: "Ready." },
        done: true,
        done_reason: "stop",
      })
    },
  })
  try {
    for (const context of [65536, 131072]) {
      const fetcher = ollama(
        {
          localInference: true,
          localInferenceAPI: "ollama",
          localInferenceContext: context,
          localInferenceKeepAlive: 120,
        },
        fetch,
      )
      const response = await fetcher(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Hello" }] }),
      })
      expect(response.ok).toBe(true)
      expect(rows.at(-1)?.options).toEqual({ num_ctx: context })
      expect(rows.at(-1)?.keep_alive).toBe(120)
      expect(rows.at(-1)?.truncate).toBe(false)
      expect(rows.at(-1)?.shift).toBe(false)
    }
    const fetcher = ollama({ localInference: true, localInferenceAPI: "ollama" }, fetch)
    await fetcher(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Hello" }] }),
    })
    expect(rows.at(-1)?.options).toEqual({})
    expect(rows.at(-1)?.keep_alive).toBeUndefined()
  } finally {
    await server.stop(true)
  }
})

test("invalid context/residency is refused before dispatch", () => {
  for (const context of [0, 1024, 262145, 65536.5, "65536", NaN])
    expect(() =>
      ollama({ localInference: true, localInferenceAPI: "ollama", localInferenceContext: context }, fetch),
    ).toThrow(OllamaBridgeError)
  for (const idle of [-1, 601, 1.5, "120", NaN])
    expect(() =>
      ollama({ localInference: true, localInferenceAPI: "ollama", localInferenceKeepAlive: idle }, fetch),
    ).toThrow(OllamaBridgeError)
})
