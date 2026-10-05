import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { MessageV2 } from "@/session/message-v2"
import { ProviderV2 } from "@opencode-ai/core/provider"

const marker = "private-provider-error-prompt-arguments-cause-do-not-persist"
const options = {
  localInference: true,
  localInferenceAPI: "ollama",
  localInferenceToolFormat: "completion-envelope-v1",
}
const request = {
  model: "fixture",
  messages: [{ role: "user", content: marker }],
  tools: [{ type: "function", function: { name: "update_goal", parameters: { type: "object" } } }],
  tool_choice: "auto",
  stream: true,
}
const row = {
  model: "fixture",
  message: { role: "assistant", content: marker },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 7,
  eval_count: 3,
}

function inspect(err: unknown) {
  if (!(err instanceof OllamaBridgeError)) throw new Error("Expected strict refusal")
  expect(err.isRetryable).toBe(false)
  expect(err.message).not.toContain(marker)
  expect(JSON.stringify(err)).not.toContain(marker)
  const saved = MessageV2.fromError(err, { providerID: ProviderV2.ID.make("local") })
  expect(JSON.stringify(saved)).not.toContain(marker)
  expect(err.message.length).toBeLessThan(500)
  return JSON.parse(err.message.slice(err.message.indexOf(" [") + 2, -1))
}

test("real native HTTP frame refusal identifies bounded provider/schema/model/finish/tool boundaries before SSE", async () => {
  const bodies = [
    { error: marker },
    { message: marker },
    { ...row, model: marker },
    { ...row, done_reason: "length" },
    {
      ...row,
      message: { ...row.message, tool_calls: [{ function: { name: "update_goal", arguments: { secret: marker } } }] },
    },
  ]
  const state = { index: 0, requests: 0, published: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      state.requests++
      return new Response(JSON.stringify(bodies[state.index]) + "\n")
    },
  })
  try {
    for (const refusal of ["provider-error", "schema", "model", "finish", "native-tools"]) {
      const err = await ollama(options, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request),
      }).then(
        () => {
          state.published = true
        },
        (err: unknown) => err,
      )
      const diagnostic = inspect(err)
      expect(diagnostic.reason).toBe("required-frame-refusal")
      expect(diagnostic.refusal).toBe(refusal)
      expect(diagnostic.envelope).toBe(true)
      expect(diagnostic.frames).toBe(1)
      expect(diagnostic.content).toBe(0)
      if (refusal === "native-tools") expect(diagnostic.calls).toBe(1)
      state.index++
    }
    expect(state.requests).toBe(5)
    expect(state.published).toBe(false)
  } finally {
    await server.stop(true)
  }
})

test("actual stream cleanup aggregation retains the original private-safe frame classification", async () => {
  for (const body of [JSON.stringify({ error: marker }) + "\n", '{"private":"' + marker + "\n"]) {
    const state = { canceled: 0, published: false }
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(body))
      },
      cancel() {
        state.canceled++
        throw new Error(marker)
      },
    })
    const err = await ollama(options, async () => new Response(stream))("http://127.0.0.1:1/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(request),
    }).then(
      () => {
        state.published = true
      },
      (err: unknown) => err,
    )
    const diagnostic = inspect(err)
    if (!(err instanceof OllamaBridgeError) || !(err.cause instanceof AggregateError))
      throw new Error("Original cleanup causes required")
    expect(err.cause.errors).toHaveLength(2)
    expect(err.cause.errors[0]).toBeInstanceOf(OllamaBridgeError)
    expect(diagnostic.reason).toBe(body.startsWith('{"error"') ? "required-frame-refusal" : "required-frame-json")
    if (body.startsWith('{"error"')) expect(diagnostic.refusal).toBe("provider-error")
    expect(diagnostic.stage).toBe("frame")
    expect(diagnostic.cleanup).toBe("cancel")
    expect(diagnostic.frames).toBe(1)
    expect(diagnostic.bytes).toBe(Buffer.byteLength(body))
    expect(diagnostic.content).toBe(0)
    expect(state.published).toBe(false)
    expect(state.canceled).toBe(1)
    expect(stream.locked).toBe(false)
  }
})

test("native tool name diagnostics classify catalog mismatches without admitting aliases or exposing names", async () => {
  const cases = [
    ["", "empty"],
    [" read ", "whitespace-match"],
    ["READ", "case-match"],
    ["functions.read", "namespace-match"],
    ["read_file", "common-unadvertised-read"],
    [marker, "other-unadvertised"],
  ]
  for (const [name, category] of cases) {
    const state = { canceled: 0, published: false }
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              ...row,
              message: { ...row.message, tool_calls: [{ function: { name, arguments: { private: marker } } }] },
            }) + "\n",
          ),
        )
      },
      cancel() {
        state.canceled++
        throw new Error(marker)
      },
    })
    const err = await ollama({ localInference: true, localInferenceAPI: "ollama" }, async () => new Response(stream))(
      "http://127.0.0.1:1/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          ...request,
          tool_choice: "required",
          tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        }),
      },
    ).then(
      () => {
        state.published = true
      },
      (err: unknown) => err,
    )
    const diagnostic = inspect(err)
    expect(diagnostic.refusal).toBe("tool-name")
    expect(diagnostic.nameShape).toBe(category)
    expect(diagnostic.advertisedCount).toBe(1)
    expect(diagnostic.envelope).toBe(false)
    expect(diagnostic.cleanup).toBe("cancel")
    expect(diagnostic.calls).toBe(1)
    expect(Object.keys(diagnostic).sort()).toEqual(
      [
        "advertisedCount",
        "bytes",
        "calls",
        "cleanup",
        "content",
        "envelope",
        "error",
        "eval",
        "finish",
        "frames",
        "nameShape",
        "prompt",
        "reason",
        "refusal",
        "stage",
      ].sort(),
    )
    expect(state.published).toBe(false)
    expect(state.canceled).toBe(1)
    expect(stream.locked).toBe(false)
  }
})
