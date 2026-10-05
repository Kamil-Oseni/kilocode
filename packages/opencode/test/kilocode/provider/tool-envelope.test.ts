import { tool, jsonSchema } from "ai"
import { context } from "@/kilocode/provider/ollama-context"
import { expect, test } from "bun:test"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { ollama } from "@/kilocode/provider/ollama-bridge"
const tools = [
  {
    type: "function",
    function: {
      name: "update_goal",
      parameters: { type: "object", properties: { criterionID: { enum: ["verified"] } }, required: ["criterionID"] },
    },
  },
]
const options = {
  localInference: true,
  localInferenceAPI: "ollama",
  localInferenceToolFormat: "completion-envelope-v1",
}
const request = (choice = "auto", stream = false) => ({
  model: "fixture",
  messages: [{ role: "user", content: "Verify" }],
  tools,
  tool_choice: choice,
  stream,
})
const row = (content: string) => ({
  model: "fixture",
  message: { role: "assistant", content, thinking: "reason" },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 7,
  prompt_eval_cached_count: 2,
  eval_count: 3,
})

test("exact schemas and unrepaired arguments; strict outer choice/allowlist/bounds", () => {
  const properties = ToolEnvelope.schema(tools, "auto").anyOf[0].properties
  if (!("arguments" in properties)) throw new Error("Missing tool schema")
  expect(properties.arguments).toBe(tools[0].function.parameters)
  const names = new Set(["update_goal"])
  expect(
    ToolEnvelope.decode(
      '{"kind":"tool","name":"update_goal","arguments":{"criterionID":"invented"}}',
      names,
      "required",
    ).tool_calls?.[0].function.arguments,
  ).toEqual({ criterionID: "invented" })
  for (const value of [
    { kind: "tool", name: "foreign", arguments: {} },
    { kind: "tool", name: "update_goal", arguments: [] },
    { kind: "tools", calls: [] },
    { kind: "text", content: "done" },
    { kind: "tool", name: "update_goal", arguments: {}, extra: true },
  ])
    expect(() => ToolEnvelope.decode(JSON.stringify(value), names, "required")).toThrow()
  expect(() => ToolEnvelope.schema([...tools, ...tools], "auto")).toThrow()
})

test("actual HTTP envelope auto/required stream/nonstream metadata and preflight collision", async () => {
  const rows: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json()
      rows.push(body)
      const text = body.format.anyOf.some(
        (value: { properties: { kind: { const: string } } }) => value.properties.kind.const === "text",
      )
      const content = text
        ? { kind: "text", content: "answer" }
        : {
            kind: "tools",
            calls: [
              { name: "update_goal", arguments: { criterionID: "verified" } },
              { name: "update_goal", arguments: { criterionID: "other" } },
            ],
          }
      return new Response(JSON.stringify(row(JSON.stringify(content))) + (body.stream ? "\n" : ""))
    },
  })
  try {
    const send = ollama(options, fetch)
    for (const stream of [false, true])
      for (const choice of ["auto", "required"]) {
        const response = await send(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify(request(choice, stream)),
        })
        const text = await response.text()
        const value = stream ? JSON.parse(text.split("\n")[0].slice(6)) : JSON.parse(text)
        const message = value.choices[0][stream ? "delta" : "message"]
        expect(message.reasoning_content).toBe("reason")
        expect(value.usage.prompt_tokens_details.cached_tokens).toBe(2)
        expect(rows.at(-1)?.tools).toBeUndefined()
        if (choice === "auto") expect(message.content).toBe("answer")
        if (choice === "required") {
          expect(message.tool_calls).toHaveLength(2)
          expect(JSON.parse(message.tool_calls[1].function.arguments)).toEqual({ criterionID: "other" })
        }
      }
    for (const response_format of [{ type: "json_object" }, { type: "json_schema", json_schema: { schema: {} } }])
      await expect(
        send(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ ...request(), response_format }),
        }),
      ).rejects.toThrow()
    expect(JSON.stringify(rows[0].messages)).toContain("criterionID")
    expect(JSON.stringify(rows[0].messages)).toContain("verified")
    await expect(
      send(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          ...request(),
          messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 - 700) }],
        }),
      }),
    ).rejects.toThrow()
    expect(rows).toHaveLength(4)
  } finally {
    await server.stop()
  }
})

test("envelope history exposes the original transport call ID without changing evidence or native history", async () => {
  const rows: { messages: { role: string; content: string; tool_name?: string }[]; format?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json()
      rows.push(body)
      return Response.json(row(body.format ? '{"kind":"tool","name":"update_goal","arguments":{}}' : "native"))
    },
  })
  try {
    const send = ollama(options, fetch)
    const first = await send(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(request()),
    })
    const call = (await first.json()).choices[0].message.tool_calls[0]
    expect(call.id).toMatch(/^chatcmpl-.+-tool-0$/)
    const output = 'Error: real read required. Preserve C:\\fixture\\note.md and "verified".\nNot eligible.'
    const history = {
      ...request(),
      messages: [
        { role: "assistant", tool_calls: [{ id: call.id, type: call.type, function: call.function }] },
        { role: "tool", tool_call_id: call.id, content: output },
      ],
    }
    const next = await send(`${server.url}v1/chat/completions`, { method: "POST", body: JSON.stringify(history) })
    await next.text()
    const result = rows.at(-1)!.messages.find((message) => message.role === "tool")!
    expect(JSON.parse(result.content)).toEqual({ toolCallId: call.id, output })
    expect(result.tool_name).toBe("update_goal")
    expect(rows.at(-1)!.messages[0].content).toContain("never invent an ID")
    const native = await ollama({ ...options, localInferenceToolFormat: undefined }, fetch)(
      `${server.url}v1/chat/completions`,
      { method: "POST", body: JSON.stringify(history) },
    )
    await native.text()
    expect(rows.at(-1)!.messages.find((message) => message.role === "tool")!.content).toBe(output)
    expect(rows.at(-1)!.format).toBeUndefined()
  } finally {
    await server.stop()
  }
})

test("terminal auto envelope retains original EOF and cancellation join", async () => {
  const ready = Promise.withResolvers<void>()
  const end = Promise.withResolvers<void>()
  const state = { settled: false, cancelled: false }
  const send = ollama(
    options,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify(row('{"kind":"tool","name":"update_goal","arguments":{}}')) + "\n",
              ),
            )
            ready.resolve()
          },
          async cancel() {
            state.cancelled = true
            await end.promise
          },
        }),
      ),
  )
  const controller = new AbortController()
  const result = send("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify(request("auto", true)),
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
  controller.abort()
  await Promise.resolve()
  expect(state.settled).toBe(false)
  end.resolve()
  expect(await result).toBe(true)
  expect(state.cancelled).toBe(true)
})

test("none and inactive capability retain native protocol; invalid envelopes never lower", async () => {
  const rows: Record<string, unknown>[] = []
  const state = { content: '{"kind":"tool","name":"foreign","arguments":{}}' }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json()
      rows.push(body)
      return Response.json(row(body.format ? state.content : "native"))
    },
  })
  try {
    for (const cfg of [options, { ...options, localInferenceToolFormat: undefined }]) {
      const send = ollama(cfg, fetch)
      const value = await send(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(request("none")),
      })
      expect((await value.json()).choices[0].message.content).toBe("native")
      expect(rows.at(-1)?.format).toBeUndefined()
      expect(rows.at(-1)?.tools).toBeUndefined()
    }
    const send = ollama(options, fetch)
    for (const content of [
      state.content,
      '{"kind":"tools","calls":[]}',
      '{"kind":"text","content":"only text"}',
      '{"kind":"tool","name":"update_goal","arguments":null}',
    ]) {
      state.content = content
      await expect(
        send(`${server.url}v1/chat/completions`, { method: "POST", body: JSON.stringify(request("required")) }),
      ).rejects.toThrow()
    }
    await expect(
      send(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ ...request(), tool_choice: { type: "function", function: { name: "update_goal" } } }),
      }),
    ).rejects.toThrow()
  } finally {
    await server.stop()
  }
})

test("envelope failure retains original cancellation failure", async () => {
  const failure = new Error("original cleanup failed")
  const send = ollama(
    options,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ ...row("invalid"), done: false, error: "native failure" }) + "\n",
              ),
            )
          },
          cancel() {
            throw failure
          },
        }),
      ),
  )
  const result = await send("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(request("auto", true)),
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(Error)
  if (!(result instanceof Error) || !(result.cause instanceof AggregateError)) throw new Error("Missing aggregate")
  expect(result.cause.errors).toContain(failure)
})

test("native per-request original schemas restore only exact advertised names and cannot be forged", async () => {
  const captured: Record<string, unknown>[] = []
  const model = { api: { id: "fixture" }, limit: { context: 32768 } }
  const original = {
    anyOf: [
      { type: "object" as const, properties: { criterionID: { enum: ["verified"] } }, required: ["criterionID"] },
    ],
  }
  const agent = { update_goal: tool({ inputSchema: jsonSchema(original) }) }
  const cfg = context(options, model, agent)
  original.anyOf[0].properties.criterionID.enum = ["changed"]
  const send = (cfg: Record<string, unknown>) =>
    ollama(cfg, async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected bridge string body")
      captured.push(JSON.parse(init.body))
      return Response.json(row('{"kind":"tool","name":"update_goal","arguments":{}}'))
    })
  await send(cfg)("http://127.0.0.1/v1/chat/completions", { method: "POST", body: JSON.stringify(request()) })
  expect(JSON.stringify(captured[0].format)).toContain('"enum":["verified"]')
  await send(context(options, model, agent))("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(request()),
  })
  expect(JSON.stringify(captured[1].format)).toContain('"enum":["changed"]')
  await expect(
    send(cfg)("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        ...request(),
        tools: [...tools, { ...tools[0], function: { ...tools[0].function, name: "foreign" } }],
      }),
    }),
  ).rejects.toThrow()
  expect(captured).toHaveLength(2)
  await send({ ...options, ollamaSchemas: [{ name: "update_goal", parameters: original }] })(
    "http://127.0.0.1/v1/chat/completions",
    { method: "POST", body: JSON.stringify(request()) },
  )
  expect(JSON.stringify(captured[2].format)).not.toContain('"enum":["changed"]')
})
