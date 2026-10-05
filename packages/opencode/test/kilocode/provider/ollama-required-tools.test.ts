import { expect, test } from "bun:test"
import { OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { localFetch, status } from "@/kilocode/provider/local-scheduler"
import { terminal } from "@/kilocode/provider/native-admission"

const options = { localInference: true, localInferenceAPI: "ollama" }
const guidance =
  "For this response, call at least one tool from the supplied tools list. Do not return a text-only answer."
const tools = [
  {
    type: "function",
    function: {
      name: "lookup",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
]
const request = (stream = true) => ({
  model: "fixture",
  messages: [{ role: "user", content: "café 日本語" }],
  tools,
  tool_choice: "required",
  stream,
  max_tokens: 17,
})
const call = {
  model: "fixture",
  message: {
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name: "lookup", arguments: { query: "café 日本語" } } }],
  },
  done: false,
}
const done = {
  model: "fixture",
  done: true,
  done_reason: "stop",
  prompt_eval_count: 7,
  prompt_eval_cached_count: 2,
  eval_count: 3,
}
const wire = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"

function events(text: string) {
  return text
    .split("\n\n")
    .filter((row) => row.startsWith("data: {"))
    .map((row) => JSON.parse(row.slice(6)))
}

test("required guidance preserves mapped message prefixes and leaves auto and none unchanged", async () => {
  const rows: { messages: { role: string; content: string }[] }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const row = await req.json()
      rows.push(row)
      return new Response(
        row.tools ? wire([call, done]) : wire([{ ...done, message: { role: "assistant", content: "ordinary" } }]),
      )
    },
  })
  try {
    const send = localFetch(options)
    const cases = [
      [{ role: "user", content: "café 日本語" }],
      [
        { role: "system", content: "Original system 日本語" },
        { role: "user", content: "café" },
      ],
      [
        { role: "system", content: "First system" },
        { role: "user", content: "café" },
        { role: "system", content: "Second system" },
      ],
    ]
    for (const messages of cases) {
      for (const choice of ["required", "auto", "none"]) {
        const response = await send(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ ...request(), messages, tool_choice: choice }),
        })
        expect(response.status).toBe(200)
        await response.text()
        const row = rows.at(-1)!
        if (choice !== "required") {
          expect(row.messages).toEqual(messages)
          continue
        }
        if (messages[0].role === "system") {
          expect(row.messages).toEqual([
            { ...messages[0], content: messages[0].content + "\n\n" + guidance },
            ...messages.slice(1),
          ])
          continue
        }
        expect(row.messages).toEqual([{ role: "system", content: guidance }, ...messages])
      }
    }
    expect(rows).toHaveLength(9)
    expect(status().active).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test("required tool accepts real HTTP stream and nonstream response with advertised exact call and usage", async () => {
  const rows: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(new URL(req.url).pathname).toBe("/api/chat")
      const row = await req.json()
      rows.push(row)
      if (new URL(req.url).searchParams.get("counts") === "omit")
        return Response.json({ model: "fixture", message: call.message, done: true, done_reason: "stop" })
      return row.stream ? new Response(wire([call, done])) : Response.json({ ...call, ...done, message: call.message })
    },
  })
  try {
    const send = localFetch(options)
    for (const stream of [true, false]) {
      const response = await send(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          ...request(stream),
          temperature: 0.2,
          top_p: 0.7,
          seed: 123,
          stop: ["END"],
          response_format: { type: "json_object" },
        }),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      const values = stream ? events(text) : [JSON.parse(text)]
      const calls = values.flatMap((value) => (value.choices[0].delta ?? value.choices[0].message).tool_calls ?? [])
      expect(calls).toHaveLength(1)
      expect(calls[0].function).toEqual({ name: "lookup", arguments: '{"query":"café 日本語"}' })
      expect(values.at(-1).choices[0].finish_reason).toBe("tool_calls")
      expect(values.at(-1).usage).toEqual({
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        prompt_tokens_details: { cached_tokens: 2 },
      })
      if (stream) expect(text).toEndWith("data: [DONE]\n\n")
      expect(status().active).toBe(0)
    }
    const missing = await send(`${server.url}v1/chat/completions?counts=omit`, {
      method: "POST",
      body: JSON.stringify(request(false)),
    })
    expect((await missing.json()).usage).toBeUndefined()
    expect(status().active).toBe(0)
    expect(rows).toHaveLength(3)
    for (const row of rows)
      expect(row).toMatchObject({
        model: "fixture",
        tools,
        shift: false,
        truncate: false,
        options: { num_predict: 17 },
      })
    for (const row of rows.slice(0, 2))
      expect(row).toMatchObject({ format: "json", options: { temperature: 0.2, top_p: 0.7, seed: 123, stop: ["END"] } })
  } finally {
    await server.stop(true)
  }
})

test("required response stays unpublished until terminal frame AND actual HTTP EOF", async () => {
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(wire([call, done])))
            ready.resolve()
            await release.promise
            ctrl.close()
          },
        }),
      )
    },
  })
  try {
    const state = { returned: false }
    const send = localFetch(options)(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(request()),
    })
    const joined = send.then((response) => {
      state.returned = true
      return response.text()
    })
    const settled = Promise.allSettled([joined])
    await ready.promise
    // A real complete terminal frame is on the socket, but EOF is deliberately withheld.
    await Bun.sleep(50)
    expect(state.returned).toBe(false)
    expect(status().active).toBe(1)
    release.resolve()
    const result = await settled
    expect(result[0].status).toBe("fulfilled")
    if (result[0].status === "fulfilled")
      expect(events(result[0].value).flatMap((row) => row.choices[0].delta.tool_calls ?? [])).toHaveLength(1)
    expect(status().active).toBe(0)
  } finally {
    release.resolve()
    await server.stop(true)
  }
})

test("required rejects missing empty or ambiguous advertised tools before HTTP with terminal nonretryable error", async () => {
  const rows: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      rows.push(await req.json())
      return new Response(wire([call, done]))
    },
  })
  try {
    const errors: unknown[] = []
    const send = terminal(localFetch(options), (err) => errors.push(err))
    for (const declared of [
      undefined,
      [],
      [...tools, ...tools],
      [{ type: "function", function: { name: "", parameters: {} } }],
    ]) {
      const response = await send(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ ...request(), tools: declared }),
      })
      expect(response.status).toBe(400)
      expect(response.headers.get("x-raya-local-admission")).toBe("ollama-bridge")
      expect((await response.json()).error.code).toBe("ollama-bridge")
      expect(status().active).toBe(0)
    }
    expect(rows).toEqual([])
    expect(errors).toHaveLength(4)
    for (const err of errors) {
      expect(err).toBeInstanceOf(OllamaBridgeError)
      if (!(err instanceof OllamaBridgeError)) throw new Error("Expected terminal bridge failure")
      expect(err.isRetryable).toBe(false)
    }
  } finally {
    await server.stop(true)
  }
})

test("required refuses real HTTP invalid or incomplete calls without publishing any converted bytes", async () => {
  const rows: string[] = []
  const cases = [
    ["textonly", wire([{ model: "fixture", message: { role: "assistant", content: "answer" }, done: true }])],
    [
      "unknown",
      wire([
        { ...call, message: { ...call.message, tool_calls: [{ function: { name: "foreign", arguments: {} } }] } },
        done,
      ]),
    ],
    [
      "malformed",
      wire([
        { ...call, message: { ...call.message, tool_calls: [{ function: { name: "lookup", arguments: [] } }] } },
        done,
      ]),
    ],
    ["length", wire([call, { ...done, done_reason: "length" }])],
    ["incomplete", wire([call])],
    ["duplicate", wire([call, done, done])],
    ["afterdone", wire([call, done, call])],
    ["nativeerror", wire([call, { ...done, error: "fixture error" }])],
    [
      "model",
      wire([
        { ...call, model: "foreign" },
        { ...done, model: "foreign" },
      ]),
    ],
    ["badjson", wire([call]) + '{"done":true\n'],
  ] as const
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json()
      const mode = new URL(req.url).searchParams.get("case")
      rows.push(mode ?? "missing")
      const value = cases.find(([name]) => name === mode)
      expect(value).toBeDefined()
      return new Response(value![1])
    },
  })
  try {
    const send = localFetch(options)
    for (const [model] of cases) {
      const state = { published: false }
      const err = await send(`${server.url}v1/chat/completions?case=${model}`, {
        method: "POST",
        body: JSON.stringify(request()),
      }).then(
        async (response) => {
          state.published = true
          await response.text()
          return undefined
        },
        (err: unknown) => err,
      )
      expect({ model, published: state.published }).toEqual({ model, published: false })
      expect(err).toBeInstanceOf(OllamaBridgeError)
      expect(status().active).toBe(0)
    }
    const errors: unknown[] = []
    const refused = await terminal(localFetch(options), (err) => errors.push(err))(
      `${server.url}v1/chat/completions?case=malformed`,
      {
        method: "POST",
        body: JSON.stringify(request()),
      },
    )
    expect(refused.status).toBe(400)
    expect(refused.headers.get("x-raya-local-admission")).toBe("ollama-bridge")
    expect((await refused.json()).error.code).toBe("ollama-bridge")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(OllamaBridgeError)
    expect(rows).toHaveLength(cases.length + 1)
    expect(status().active).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test("required validates UTF8 and cumulative byte frame and call bounds on actual HTTP", async () => {
  const repeated = { model: "fixture", message: { role: "assistant", content: "" }, done: false }
  const cases: Record<string, string | Uint8Array> = {
    utf8: new Uint8Array([0xc3, 0x28]),
    bytes: wire([{ ...call, message: { ...call.message, content: "x".repeat(2 * 1024 * 1024) } }, done]),
    frames: wire([...Array.from({ length: 4096 }, () => repeated), call, done]),
    calls: wire([
      {
        ...call,
        message: { ...call.message, tool_calls: Array.from({ length: 129 }, () => call.message.tool_calls[0]) },
      },
      done,
    ]),
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json()
      const value = cases[new URL(req.url).searchParams.get("case")!]
      return new Response(typeof value === "string" ? value : new Uint8Array(value).buffer)
    },
  })
  try {
    const send = localFetch(options)
    for (const model of Object.keys(cases)) {
      const err = await send(`${server.url}v1/chat/completions?case=${model}`, {
        method: "POST",
        body: JSON.stringify(request()),
      }).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(err).toBeInstanceOf(OllamaBridgeError)
      expect(status().active).toBe(0)
    }
  } finally {
    await server.stop(true)
  }
})

test("abort of buffered required HTTP response joins actual request cancellation and releases local slot", async () => {
  const ready = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(wire([call])))
            ready.resolve()
          },
        }),
      )
    },
  })
  try {
    const controller = new AbortController()
    const send = localFetch(options)(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(request()),
      signal: controller.signal,
    })
    const joined = Promise.allSettled([send])
    await ready.promise
    expect(status().active).toBe(1)
    controller.abort(new Error("Private required test cancellation"))
    const result = await joined
    expect(result[0].status).toBe("rejected")
    const timer = setTimeout(() => aborted.reject(new Error("Actual HTTP abort missing")), 2000)
    await aborted.promise.finally(() => clearTimeout(timer))
    expect(status().active).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test("auto and none retain actual ordinary native request and response compatibility", async () => {
  const rows: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const row = await req.json()
      rows.push(row)
      return new Response(
        row.tools ? wire([call, done]) : wire([{ ...done, message: { role: "assistant", content: "ordinary" } }]),
      )
    },
  })
  try {
    const send = localFetch(options)
    for (const choice of ["auto", "none"]) {
      const response = await send(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ ...request(), tool_choice: choice }),
      })
      const values = events(await response.text())
      expect(values.at(-1).choices[0].finish_reason).toBe(choice === "auto" ? "tool_calls" : "stop")
      if (choice === "none") expect(values[0].choices[0].delta).toEqual({ content: "ordinary" })
      expect(status().active).toBe(0)
    }
    expect(rows[0].tools).toEqual(tools)
    expect(rows[1].tools).toBeUndefined()
  } finally {
    await server.stop(true)
  }
})

test("required full-response timeout cancels real HTTP without publishing a partial call", async () => {
  const ready = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(wire([call, done])))
            ready.resolve()
          },
        }),
      )
    },
  })
  try {
    const send = localFetch({ ...options, timeout: 100 })(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(request()),
    })
    const joined = Promise.allSettled([send])
    await ready.promise
    const result = await joined
    expect(result[0].status).toBe("rejected")
    if (result[0].status === "rejected") expect(result[0].reason).toBeInstanceOf(OllamaBridgeError)
    const timer = setTimeout(() => aborted.reject(new Error("Required timeout did not cancel actual HTTP")), 2000)
    await aborted.promise.finally(() => clearTimeout(timer))
    expect(status().active).toBe(0)
  } finally {
    await server.stop(true)
  }
})
