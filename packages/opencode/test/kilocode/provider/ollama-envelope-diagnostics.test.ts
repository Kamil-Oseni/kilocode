import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { MessageV2 } from "@/session/message-v2"
import { ProviderV2 } from "@opencode-ai/core/provider"

const options = {
  localInference: true,
  localInferenceAPI: "ollama",
  localInferenceToolFormat: "completion-envelope-v1",
}
const marker = "synthetic-private-payload"
const tools = [{ type: "function", function: { name: "update_goal", parameters: { type: "object" } } }]
const request = (stream: boolean, choice = "auto") => ({
  model: "fixture",
  messages: [{ role: "user", content: marker }],
  tools,
  tool_choice: choice,
  stream,
})
const terminal = { model: "fixture", done: true, done_reason: "stop", prompt_eval_count: 47, eval_count: 31 }
function diagnostic(error: OllamaBridgeError) {
  const start = error.message.indexOf(" [")
  expect(start).toBeGreaterThan(0)
  return JSON.parse(error.message.slice(start + 2, -1))
}

test("actual native HTTP refuses malformed inner JSON before emitting a response and retains only bounded metrics", async () => {
  const content = '{"kind":"tool","name":"update_goal","arguments":{"note":"' + marker
  const bodies: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json()
      const message = { role: "assistant", content }
      const text = body.stream
        ? [JSON.stringify({ model: "fixture", message, done: false }), JSON.stringify(terminal)].join("\n") + "\n"
        : JSON.stringify({ ...terminal, message })
      bodies.push(text)
      return new Response(text)
    },
  })
  try {
    for (const stream of [false, true]) {
      const error = await ollama(options, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request(stream)),
      }).then(
        () => undefined,
        (err: unknown) => err,
      )
      if (!(error instanceof OllamaBridgeError)) throw new Error("Expected terminal bridge refusal")
      expect(error.isRetryable).toBe(false)
      expect(error.cause).toBeUndefined()
      expect(diagnostic(error)).toEqual({
        reason: "envelope-json",
        finish: "stop",
        prompt: 47,
        eval: 31,
        bytes: Buffer.byteLength(bodies.at(-1)!),
        frames: stream ? 2 : 1,
        content: Buffer.byteLength(content),
      })
      const saved = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("local") })
      expect(saved.name).toBe("UnknownError")
      const encoded = JSON.stringify(saved)
      expect(encoded).toContain("envelope-json")
      expect(encoded).not.toContain(marker)
      expect(encoded).not.toContain("arguments")
      expect(error.message.length).toBeLessThan(350)
    }
  } finally {
    await server.stop(true)
  }
})

test("actual native HTTP classifies schema and allowlist refusals without repairing the envelope", async () => {
  const cases = [
    { content: { kind: "tool", name: "update_goal", arguments: [] }, reason: "envelope-schema", choice: "auto" },
    { content: { kind: "tool", name: marker, arguments: {} }, reason: "envelope-validation", choice: "auto" },
    { content: { kind: "text", content: marker }, reason: "envelope-validation", choice: "required" },
  ]
  const state = { index: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        ...terminal,
        message: { role: "assistant", content: JSON.stringify(cases[state.index].content) },
      })
    },
  })
  try {
    for (const row of cases) {
      const error = await ollama(options, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request(false, row.choice)),
      }).then(
        () => undefined,
        (err: unknown) => err,
      )
      if (!(error instanceof OllamaBridgeError)) throw new Error("Expected terminal bridge refusal")
      expect(diagnostic(error).reason).toBe(row.reason)
      expect(error.isRetryable).toBe(false)
      expect(error.message).not.toContain(marker)
      state.index++
    }
  } finally {
    await server.stop(true)
  }
})

test("non-stop native termination stays refused and valid completed envelopes remain accepted", async () => {
  const state = { finish: "length" }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        ...terminal,
        done_reason: state.finish,
        message: { role: "assistant", content: '{"kind":"tool","name":"update_goal","arguments":{}}' },
      })
    },
  })
  try {
    const send = () =>
      ollama(options, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request(false)),
      })
    const error = await send().then(
      () => undefined,
      (err: unknown) => err,
    )
    if (!(error instanceof OllamaBridgeError)) throw new Error("Expected non-stop terminal refusal")
    expect(error.message).toBe("Unsupported or invalid Ollama bridge request or response")
    state.finish = "stop"
    const response = await send()
    const value = await response.json()
    expect(value.choices[0].message.tool_calls).toHaveLength(1)
    expect(value.choices[0].message.tool_calls[0].function.name).toBe("update_goal")
  } finally {
    await server.stop(true)
  }
})

test("diagnostic construction whitelists finish and refuses unsafe or excessive numeric metrics", () => {
  const error = new OllamaBridgeError({
    diagnostic: {
      reason: "envelope-json",
      finish: marker,
      prompt: Number.MAX_SAFE_INTEGER + 1,
      eval: -1,
      bytes: 2 * 1024 * 1024 + 1,
      frames: 4097,
      content: Infinity,
    },
  })
  expect(diagnostic(error)).toEqual({ reason: "envelope-json", finish: "other" })
  expect(error.message).not.toContain(marker)
  expect(error.isRetryable).toBe(false)
})
