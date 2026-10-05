import { expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Schema } from "effect"
import { context } from "@/kilocode/provider/ollama-context"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { Parameters } from "@/kilocode/tool/chief-route"
import { ToolJsonSchema } from "@/tool/json-schema"

const options = {
  localInference: true,
  localInferenceAPI: "ollama",
  localInferenceToolFormat: "completion-envelope-v1",
}
const model = { api: { id: "fixture" }, limit: { context: 32768 } }
const original = ToolJsonSchema.fromSchema(Parameters)
const tools = [{ type: "function", function: { name: "chief_route", parameters: original } }]
const args = {
  objective: "Delegate the requested fixture file work",
  workflow: "specialist" as const,
  access: "edit" as const,
}
const envelope = JSON.stringify({ kind: "tool", name: "chief_route", arguments: args })
const request = (choice = "required", stream = false) => ({
  model: "fixture",
  messages: [{ role: "user", content: "Route this synthetic request" }],
  tools,
  tool_choice: choice,
  stream,
})
const row = (content = envelope) => ({
  model: "fixture",
  message: { role: "assistant", content },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 7,
  eval_count: 3,
})

test("fresh Chief calls require a work class in the actual model schema", () => {
  expect(original.required).toContain("access")
  expect(() => Schema.decodeUnknownSync(Parameters)({ objective: args.objective, workflow: args.workflow })).toThrow()
  for (const access of ["read", "edit", "computer"] as const)
    expect(Schema.decodeUnknownSync(Parameters)({ ...args, access }).access).toBe(access)
})

test("required sole Chief routing sends its actual immutable schema and preserves ordinary tool IDs", async () => {
  const entries = { chief_route: tool({ inputSchema: jsonSchema(original) }) }
  const cfg = context(options, model, entries)
  const captured: {
    format: { anyOf: { properties: { name?: { const: string }; arguments?: unknown } }[] }
    tools?: unknown
    messages: { role: string; content: string; tool_name?: string }[]
  }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json()
      captured.push(body)
      return new Response(JSON.stringify(row()) + (body.stream ? "\n" : ""))
    },
  })
  try {
    for (const stream of [false, true]) {
      const response = await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request("required", stream)),
      })
      const text = await response.text()
      const value = stream ? JSON.parse(text.split("\n")[0].slice(6)) : JSON.parse(text)
      const message = value.choices[0][stream ? "delta" : "message"]
      const call = message.tool_calls[0]
      expect(call.function.name).toBe("chief_route")
      expect(JSON.parse(call.function.arguments)).toEqual(args)
      expect(Schema.decodeUnknownSync(Parameters)(JSON.parse(call.function.arguments))).toEqual(args)
      expect(call.id).toMatch(/^chatcmpl-.+-tool-0$/)
      expect(value.usage.prompt_tokens).toBe(7)
      expect(value.usage.completion_tokens).toBe(3)
      const native = captured.at(-1)!
      expect(native.tools).toBeUndefined()
      expect(native.format.anyOf[0].properties.name).toEqual({ const: "chief_route" })
      expect(native.format.anyOf[0].properties.arguments).toEqual(original)
      const history = {
        ...request(),
        messages: [
          { role: "assistant", tool_calls: [{ id: call.id, type: call.type, function: call.function }] },
          { role: "tool", tool_call_id: call.id, content: "Original routing result" },
        ],
      }
      await (
        await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, { method: "POST", body: JSON.stringify(history) })
      ).text()
      const result = captured.at(-1)!.messages.find((message) => message.role === "tool")!
      expect(JSON.parse(result.content)).toEqual({ toolCallId: call.id, output: "Original routing result" })
      expect(result.tool_name).toBe("chief_route")
    }
  } finally {
    await server.stop()
  }
})

test("absent opt-in, automatic choice, multiple tools and a foreign sole tool keep native protocol", async () => {
  const captured: { format?: unknown; tools?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json()
      captured.push(body)
      return Response.json({
        ...row("native"),
        message: {
          role: "assistant",
          content: "native",
          tool_calls: body.tools ? [{ function: { name: body.tools[0].function.name, arguments: {} } }] : undefined,
        },
      })
    },
  })
  try {
    const cases = [
      { cfg: { ...options, localInferenceToolFormat: undefined }, value: request() },
      { cfg: options, value: request("auto") },
      { cfg: options, value: { ...request(), tool_choice: undefined } },
      {
        cfg: options,
        value: { ...request(), tools: [...tools, { type: "function", function: { name: "read", parameters: {} } }] },
      },
      {
        cfg: options,
        value: { ...request(), tools: [{ type: "function", function: { name: "foreign", parameters: {} } }] },
      },
      { cfg: options, value: request("none") },
    ]
    for (const item of cases) {
      const response = await ollama(item.cfg, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(item.value),
      })
      expect((await response.json()).choices[0].message.content).toBe("native")
      expect(captured.at(-1)?.format).toBeUndefined()
    }
    expect(captured).toHaveLength(cases.length)
  } finally {
    await server.stop()
  }
})

test("Chief routing constrained responses retain strict name, outer shape, native finish and EOF refusals", async () => {
  const state = { rows: [row()] as Record<string, unknown>[] }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      return new Response(state.rows.map((value) => JSON.stringify(value) + "\n").join(""))
    },
  })
  try {
    const invalid = [
      [row('{"kind":"tool","name":"task","arguments":{}}')],
      [row('{"kind":"tool","name":"chief_route","arguments":[]}')],
      [row('{"kind":"tool","name":"chief_route","arguments":{},"extra":true}')],
      [row('{"kind":"text","content":"only text"}')],
      [row("invalid JSON")],
      [
        {
          ...row(),
          message: {
            role: "assistant",
            content: envelope,
            tool_calls: [{ function: { name: "chief_route", arguments: {} } }],
          },
        },
      ],
      [{ ...row(), done_reason: "length" }],
      [{ ...row(), eval_count: -1 }],
      [row(), row()],
    ]
    for (const stream of [false, true])
      for (const rows of invalid) {
        state.rows = rows
        const error = await ollama(
          context(options, model, { chief_route: tool({ inputSchema: jsonSchema(original) }) }),
          fetch,
        )(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify(request("required", stream)),
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(error).toBeInstanceOf(OllamaBridgeError)
        expect(error).toMatchObject({ isRetryable: false })
      }
    // The transport never repairs semantic arguments: the actual tool schema still owns their refusal.
    state.rows = [row('{"kind":"tool","name":"chief_route","arguments":{"objective":7}}')]
    const response = await ollama(options, fetch)(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(request()),
    })
    const call = (await response.json()).choices[0].message.tool_calls[0]
    expect(JSON.parse(call.function.arguments)).toEqual({ objective: 7 })
    expect(() => Schema.decodeUnknownSync(Parameters)(JSON.parse(call.function.arguments))).toThrow()
    // Preserve the existing required transport policy: absent counters are not fabricated as zero usage.
    state.rows = [{ ...row(), eval_count: undefined }]
    const missing = await ollama(options, fetch)(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(request()),
    })
    expect((await missing.json()).usage).toBeUndefined()
  } finally {
    await server.stop()
  }
})

test("Chief routing waits for original EOF and cancellation cleanup before rejecting", async () => {
  const ready = Promise.withResolvers<void>()
  const end = Promise.withResolvers<void>()
  const state = { settled: false, cancelled: false }
  const send = ollama(
    options,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(row()) + "\n"))
            ready.resolve()
          },
          async cancel() {
            state.cancelled = true
            await end.promise
          },
        }),
      ),
  )
  const owner = new AbortController()
  const pending = send("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    signal: owner.signal,
    body: JSON.stringify(request("required", true)),
  }).then(
    () => {
      state.settled = true
      return false
    },
    () => {
      state.settled = true
      return true
    },
  )
  await ready.promise
  expect(state.settled).toBe(false)
  owner.abort()
  await Promise.resolve()
  expect(state.settled).toBe(false)
  end.resolve()
  expect(await pending).toBe(true)
  expect(state.cancelled).toBe(true)
})

test("Chief original schema snapshots are immutable and exact current catalogs cannot drift", async () => {
  const schema = structuredClone(original)
  const cfg = context(options, model, { chief_route: tool({ inputSchema: jsonSchema(schema) }) })
  Object.assign(schema, { description: "Changed after snapshot" })
  const captured: { format: unknown }[] = []
  const send = ollama(cfg, async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected actual serialized bridge request")
    captured.push(JSON.parse(init.body))
    return Response.json(row())
  })
  await (await send("http://127.0.0.1/v1/chat/completions", { method: "POST", body: JSON.stringify(request()) })).text()
  expect(JSON.stringify(captured[0].format)).not.toContain("Changed after snapshot")
  const error = await send("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      ...request(),
      tools: [...tools, { type: "function", function: { name: "update_goal", parameters: {} } }],
    }),
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(OllamaBridgeError)
  expect(captured).toHaveLength(1)
})
