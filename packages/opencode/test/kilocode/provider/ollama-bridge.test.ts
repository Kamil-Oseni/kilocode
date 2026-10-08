import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { localFetch, status } from "@/kilocode/provider/local-scheduler"
import { terminal } from "@/kilocode/provider/native-admission"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"

for (const disabled of [false, true]) {
  test(`local envelope final text retains reply guidance after tools are ${disabled ? "disabled" : "removed"}`, async () => {
    const rows: Record<string, unknown>[] = []
    const text = "RaYA_Ω_007\n"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        rows.push(await req.json())
        return Response.json({
          model: "fixture",
          message: { role: "assistant", content: text },
          done: true,
          done_reason: "stop",
        })
      },
    })
    try {
      const send = ollama(
        { localInference: true, localInferenceAPI: "ollama", localInferenceToolFormat: "completion-envelope-v1" },
        globalThis.fetch,
      )
      const response = await send(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "fixture",
          messages: [
            { role: "system", content: "Existing agent instructions" },
            { role: "user", content: `Reply exactly ${JSON.stringify(text)}` },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "original-call", type: "function", function: { name: "update_goal", arguments: "{}" } },
              ],
            },
            { role: "tool", tool_call_id: "original-call", content: "Original result" },
          ],
          tools: disabled
            ? [{ type: "function", function: { name: "update_goal", parameters: { type: "object" } } }]
            : [],
          ...(disabled ? { tool_choice: "none" } : {}),
        }),
      })
      const body = await response.json()
      expect(body.choices[0].message.content).toBe(text)
      expect(rows).toHaveLength(1)
      expect(rows[0].format).toBeUndefined()
      expect(rows[0].tools).toEqual(disabled ? undefined : [])
      expect(rows[0].messages).toEqual([
        { role: "system", content: "Existing agent instructions\n\n" + ToolEnvelope.reply() },
        { role: "user", content: `Reply exactly ${JSON.stringify(text)}` },
        {
          role: "assistant",
          content: JSON.stringify({ kind: "tools", calls: [{ name: "update_goal", arguments: {} }], content: "" }),
        },
        {
          role: "tool",
          tool_name: "update_goal",
          content: JSON.stringify({ toolCallId: "original-call", output: "Original result" }),
        },
      ])
    } finally {
      await server.stop()
    }
  })
}

test("real HTTP bridge forwards refusal flags and converts split tool/thinking NDJSON with usage", async () => {
  const rows: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      expect(new URL(req.url).pathname).toBe("/api/chat")
      const row = await req.json()
      rows.push(row)
      const encoder = new TextEncoder()
      const chunks = [
        { model: "fixture", message: { role: "assistant", content: "café", thinking: "reason" }, done: false },
        {
          model: "fixture",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "read", arguments: { path: "file" } } }],
          },
          done: false,
        },
        {
          model: "fixture",
          done: true,
          done_reason: "stop",
          prompt_eval_count: 7,
          prompt_eval_cached_count: 2,
          eval_count: 3,
        },
      ]
      return new Response(
        new ReadableStream({
          start(ctrl) {
            const bytes = encoder.encode(chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n")
            ctrl.enqueue(bytes.slice(0, 15))
            ctrl.enqueue(bytes.slice(15))
            ctrl.close()
          },
        }),
      )
    },
  })
  try {
    const fetch = localFetch({ localInference: true, localInferenceAPI: "ollama" })
    const res = await fetch(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        max_tokens: 1024,
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      }),
    })
    const text = await res.text()
    expect(rows[0]).toMatchObject({ shift: false, truncate: false, options: { num_predict: 1024 } })
    const events = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)))
    expect(events[0].choices[0].delta).toEqual({ content: "café", reasoning_content: "reason" })
    expect(events[1].choices[0].delta.tool_calls[0].function).toEqual({ name: "read", arguments: '{"path":"file"}' })
    expect(events[2].choices[0].finish_reason).toBe("tool_calls")
    expect(events[2].usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 2 },
    })
    expect(text).toEndWith("data: [DONE]\n\n")
    expect(status().active).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test("bounded UTF-8 byte bodies preserve Unicode and reject malformed or unsupported representations before HTTP", async () => {
  const rows: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      rows.push(await req.json())
      return Response.json({ model: "fixture", message: { role: "assistant", content: "ok" }, done: true })
    },
  })
  try {
    const selected = ollama({ localInference: true, localInferenceAPI: "ollama" }, fetch)
    const bytes = new TextEncoder().encode(
      JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "café 漢字" }], store: false }),
    )
    for (const body of [bytes, bytes.buffer]) {
      const res = await selected(`${server.url}v1/chat/completions`, { method: "POST", body })
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ messages: [{ role: "user", content: "café 漢字" }] })
    for (const body of [
      new Uint8Array([0xc3, 0x28]),
      new Uint8Array(2 * 1024 * 1024 + 1),
      new ReadableStream(),
      new TextEncoder().encode(JSON.stringify({ model: "fixture", messages: [], store: true })),
      new TextEncoder().encode(
        JSON.stringify({
          model: "fixture",
          messages: [{ role: "user", content: "hello", reasoning_content: "invalid-role" }],
        }),
      ),
    ]) {
      const err = await selected(`${server.url}v1/chat/completions`, { method: "POST", body }).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(err).toBeInstanceOf(OllamaBridgeError)
    }
    const err = await selected(
      new Request(`${server.url}v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "fixture" }) }),
    ).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(err).toBeInstanceOf(OllamaBridgeError)
    expect(rows).toHaveLength(2)
  } finally {
    await server.stop(true)
  }
})

test("nonstream translation, unsupported features and ordinary transports remain explicit", async () => {
  const rows: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      rows.push(await req.json())
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: "answer" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 4,
        eval_count: 2,
      })
    },
  })
  try {
    const fetch = ollama({ localInference: true, localInferenceAPI: "ollama" }, globalThis.fetch)
    const body = { model: "fixture", messages: [{ role: "user", content: "hello" }] }
    const res = await fetch(`${server.url}v1/chat/completions`, { method: "POST", body: JSON.stringify(body) })
    expect((await res.json()).choices[0]).toMatchObject({ message: { content: "answer" }, finish_reason: "length" })
    const error = await fetch(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ ...body, logprobs: true }),
    }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeInstanceOf(OllamaBridgeError)
    expect(rows).toHaveLength(1)
    const errors: unknown[] = []
    const native = terminal(localFetch({ localInference: true, localInferenceAPI: "ollama" }), (err) =>
      errors.push(err),
    )
    const refused = await native(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ ...body, logprobs: true }),
    })
    expect(refused.status).toBe(400)
    expect(errors[0]).toBeInstanceOf(OllamaBridgeError)
    expect(errors).toHaveLength(1)
    expect(rows).toHaveLength(1)
    expect(ollama({ localInference: true }, globalThis.fetch)).toBe(globalThis.fetch)
    expect(() => ollama({ localInferenceAPI: "ollama" }, globalThis.fetch)).toThrow(OllamaBridgeError)
  } finally {
    await server.stop(true)
  }
})

test("actual native HTTP refusal stays status400 and active stream cancellation joins scheduler", async () => {
  const aborted = Promise.withResolvers<void>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      if (body.model === "overflow") return Response.json({ error: "fixture context overflow" }, { status: 400 })
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      return new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ model: "fixture", message: { role: "assistant", content: "first" }, done: false }) +
                  "\n",
              ),
            )
          },
        }),
      )
    },
  })
  try {
    const fetch = localFetch({ localInference: true, localInferenceAPI: "ollama" })
    const opts = (model: string) => ({ method: "POST", body: JSON.stringify({ model, messages: [], stream: true }) })
    const refusal = await fetch(`${server.url}v1/chat/completions`, opts("overflow"))
    expect(refusal.status).toBe(400)
    expect(await refusal.json()).toEqual({
      error: { message: "fixture context overflow", type: "invalid_request_error", code: null },
    })
    const res = await fetch(`${server.url}v1/chat/completions`, opts("fixture"))
    const reader = res.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
    await Promise.race([
      aborted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP abort not observed")), 2000)),
    ])
    expect(status().active).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test("real HTTP recognizes exact nested native overflow but does not promote unrelated400 errors", async () => {
  const message = "request (33310 tokens) exceeds the available context size (32768 tokens), try increasing it"
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const row = await req.json()
      return Response.json(
        {
          error:
            row.model === "overflow"
              ? JSON.stringify({
                  error: {
                    code: 400,
                    message,
                    type: "exceed_context_size_error",
                    n_prompt_tokens: 33310,
                    n_ctx: 32768,
                  },
                })
              : "unsupported context option",
        },
        { status: 400 },
      )
    },
  })
  try {
    const fetch = localFetch({ localInference: true, localInferenceAPI: "ollama" })
    for (const model of ["overflow", "other"]) {
      const res = await fetch(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model, messages: [] }),
      })
      const row = await res.json()
      expect(res.status).toBe(400)
      expect(row.error.code).toBe(model === "overflow" ? "context_length_exceeded" : null)
      if (model === "overflow") expect(row.error.message).toBe(message)
    }
  } finally {
    await server.stop(true)
  }
})

test("duplicate done and incomplete native stream fail closed and release the local slot", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const row = await req.json()
      const data =
        JSON.stringify({
          model: "fixture",
          message: { role: "assistant", content: "" },
          done: row.model === "duplicate",
        }) + "\n"
      return new Response(row.model === "duplicate" ? data + data : data)
    },
  })
  try {
    const fetch = localFetch({ localInference: true, localInferenceAPI: "ollama" })
    for (const model of ["duplicate", "incomplete"]) {
      const res = await fetch(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model, messages: [], stream: true }),
      })
      const error = await res.text().then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(error).toBeInstanceOf(OllamaBridgeError)
      expect(status().active).toBe(0)
    }
  } finally {
    await server.stop(true)
  }
})
