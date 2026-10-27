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
  max_tokens: 1024,
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

test("envelope routing instructions follow the actual advertised tool catalog", () => {
  const catalog = (...names: string[]) => names.map((name) => ({ function: { name, parameters: {} } }))
  const chief = ToolEnvelope.guide(catalog("chief_route", "inspect_routines", "assign_organization_work"))
  expect(chief).toContain("Submit chief_route alone and wait for its actual routing decision")
  expect(chief).toContain("Submit assign_organization_work alone and wait for its actual assignment result")
  expect(chief).not.toContain("Call inspect_routines first")
  const routine = ToolEnvelope.guide(catalog("inspect_routines", "assign_organization_work"))
  expect(routine).not.toContain("chief_route")
  expect(routine).toContain("call inspect_routines only if it has not already succeeded")
  expect(routine).toContain("Reuse that successful result across subsequent responses")
  expect(routine).toContain("actual stale-revision error or a relevant saved-state change")
  expect(routine).toContain("exact IDs and revision")
  expect(routine).toContain("A saved assignment is not completed worker output")
  expect(routine).toContain("Submit assign_organization_work alone and wait for its actual assignment result")
  expect(ToolEnvelope.guide(catalog("assign_organization_work"))).toContain(
    "Never duplicate or race worker assignments",
  )
  const inspection = ToolEnvelope.guide(catalog("inspect_routines"))
  expect(inspection).toContain("call inspect_routines only if it has not already succeeded")
  expect(inspection).not.toContain("assign_organization_work")
  const other = ToolEnvelope.guide(tools)
  expect(other).not.toContain("chief_route")
  expect(other).not.toContain("inspect_routines")
  expect(other).not.toContain("assign_organization_work")
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

test("Goal mutations reject entire concurrent envelopes and preserve independent calls", () => {
  const names = new Set(["update_goal", "read", "chief_route", "assign_organization_work"])
  const mutation = { name: "update_goal", arguments: { criterionID: "verified" } }
  const read = { name: "read", arguments: { criterionID: "other" } }
  const assignment = { name: "assign_organization_work", arguments: { workerID: "researcher" } }
  expect(
    ToolEnvelope.decode(JSON.stringify({ kind: "tools", calls: [assignment] }), names, "required").tool_calls,
  ).toEqual([{ function: assignment }])
  for (const calls of [
    [assignment, { ...assignment, arguments: { workerID: "builder" } }],
    [assignment, read],
    [read, assignment],
    [assignment, mutation],
  ])
    expect(() => ToolEnvelope.decode(JSON.stringify({ kind: "tools", calls }), names, "required")).toThrow(
      "Worker assignment requires a separate single-call envelope",
    )
  expect(() =>
    ToolEnvelope.decode(
      JSON.stringify({ kind: "tools", calls: [{ name: "chief_route", arguments: {} }, assignment] }),
      names,
      "required",
    ),
  ).toThrow("Chief routing requires a separate single-call envelope")
  expect(
    ToolEnvelope.decode(JSON.stringify({ kind: "tools", calls: [mutation] }), names, "required").tool_calls,
  ).toEqual([{ function: mutation }])
  for (const calls of [
    [mutation, mutation],
    [mutation, read],
    [read, mutation],
  ])
    expect(() => ToolEnvelope.decode(JSON.stringify({ kind: "tools", calls }), names, "required")).toThrow(
      "Goal mutations require a separate single-call envelope",
    )
  expect(
    ToolEnvelope.decode(JSON.stringify({ kind: "tools", calls: [read, read] }), names, "required").tool_calls,
  ).toEqual([{ function: read }, { function: read }])
  const definitions = [
    ...tools,
    { function: { name: "assign_organization_work", parameters: {} } },
    { function: { name: "chief_route", parameters: {} } },
    { function: { name: "read", parameters: tools[0].function.parameters } },
  ]
  const batches = ToolEnvelope.schema(definitions, "required").anyOf.filter(
    (branch) => branch.properties.kind.const === "tools",
  )
  expect(batches).toHaveLength(2)
  for (const branch of batches) {
    if (!("calls" in branch.properties)) throw new Error("Missing calls schema")
    const calls = branch.properties.calls
    expect(calls.items.anyOf.map((item) => item.properties.name.const)).toEqual(
      calls.maxItems === 1 ? ["update_goal", "assign_organization_work", "chief_route"] : ["read"],
    )
  }
})

test("actual HTTP envelope auto/required stream/nonstream metadata and preflight collision", async () => {
  const batch = [{ ...tools[0], function: { ...tools[0].function, name: "inspect" } }]
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
              { name: "inspect", arguments: { criterionID: "verified" } },
              { name: "inspect", arguments: { criterionID: "other" } },
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
          body: JSON.stringify({ ...request(choice, stream), tools: batch }),
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
  const rows: {
    messages: { role: string; content: string; tool_name?: string; tool_calls?: unknown }[]
    format?: unknown
  }[] = []
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
    const note = 'Preserve "quoted" reasoning and C:\\fixture\\note.md.\nDo not claim completion.'
    const history = {
      ...request(),
      messages: [
        { role: "assistant", content: note, tool_calls: [{ id: call.id, type: call.type, function: call.function }] },
        { role: "tool", tool_call_id: call.id, content: output },
      ],
    }
    const next = await send(`${server.url}v1/chat/completions`, { method: "POST", body: JSON.stringify(history) })
    await next.text()
    const result = rows.at(-1)!.messages.find((message) => message.role === "tool")!
    expect(JSON.parse(result.content)).toEqual({ toolCallId: call.id, output })
    expect(result.tool_name).toBe("update_goal")
    const assistant = rows.at(-1)!.messages.find((message) => message.role === "assistant")!
    expect(assistant.tool_calls).toBeUndefined()
    expect(JSON.parse(assistant.content)).toEqual({
      kind: "tools",
      calls: [{ name: call.function.name, arguments: JSON.parse(call.function.arguments) }],
      content: note,
    })
    expect(rows.at(-1)!.messages[0].content).toContain("never invent an ID")
    const native = await ollama({ ...options, localInferenceToolFormat: undefined }, fetch)(
      `${server.url}v1/chat/completions`,
      { method: "POST", body: JSON.stringify(history) },
    )
    await native.text()
    expect(rows.at(-1)!.messages.find((message) => message.role === "tool")!.content).toBe(output)
    expect(rows.at(-1)!.messages.find((message) => message.role === "assistant")!.content).toBe(note)
    expect(rows.at(-1)!.messages.find((message) => message.role === "assistant")!.tool_calls).toBeDefined()
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

test("none uses final envelopes and inactive capability retains native protocol; invalid envelopes never lower", async () => {
  const rows: Record<string, unknown>[] = []
  const state = { content: '{"kind":"tool","name":"foreign","arguments":{}}' }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json()
      rows.push(body)
      return Response.json(
        row(
          body.format
            ? body.format.anyOf.length === 1 && body.format.anyOf[0].properties.kind.const === "text"
              ? JSON.stringify({ kind: "text", content: "native" })
              : state.content
            : "native",
        ),
      )
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
      expect(rows.at(-1)?.format).toEqual(cfg.localInferenceToolFormat ? ToolEnvelope.schema([], "none") : undefined)
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
