import { expect, test } from "bun:test"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"
import { ToolEnvelope } from "@/kilocode/provider/tool-envelope"
import { project } from "@/kilocode/provider/ollama-prompt"

const cfg = { localInference: true, localInferenceAPI: "ollama", localInferenceToolFormat: "completion-envelope-v1" }
const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
const history = [
  { role: "user", content: "Return the actual result" },
  {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "original", type: "function", function: { name: "read", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "original", content: "Actual controlled tool result" },
] satisfies Parameters<typeof project>[0]

test("required empty tools refuse before an actual native POST", async () => {
  const rows: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      rows.push(await req.json())
      return Response.json({})
    },
  })
  try {
    expect(ToolEnvelope.mode(true, 0, "required")).toBe("required")
    expect(() => ToolEnvelope.schema([], "required")).toThrow("Invalid envelope tool definitions")
    for (const tools of [undefined, []]) {
      const err = await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", messages: history, tools, tool_choice: "required", max_tokens: 1024 }),
      }).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(err).toBeInstanceOf(OllamaBridgeError)
    }
    expect(rows).toHaveLength(0)
  } finally {
    await server.stop()
  }
})

for (const stream of [false, true]) {
  for (const disabled of [false, true]) {
    test(`terminal envelope ${stream ? "stream" : "single"}/${disabled ? "none" : "empty"} constrains final text and preserves EOF`, async () => {
      const rows: unknown[] = []
      const state = { content: JSON.stringify({ kind: "text", content: "α\nactual result" }), native: false }
      const end = Promise.withResolvers<void>()
      const ready = Promise.withResolvers<void>()
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          rows.push(await req.json())
          const row = {
            model: "fixture",
            done: true,
            done_reason: "stop",
            message: {
              role: "assistant",
              content: state.content,
              ...(state.native ? { tool_calls: [{ function: { name: "read", arguments: {} } }] } : {}),
            },
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(row) + (stream ? "\n" : "")))
                ready.resolve()
                await end.promise
                controller.close()
              },
            }),
          )
        },
      })
      const send = () =>
        ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify({
            model: "fixture",
            messages: history,
            stream,
            tools: disabled ? tools : [],
            ...(disabled ? { tool_choice: "none" } : {}),
          }),
        })
      try {
        const joined = { value: false }
        const pending = send().then((value) => {
          joined.value = true
          return value
        })
        await ready.promise
        expect(joined.value).toBe(false)
        end.resolve()
        const response = await pending
        const raw = await response.text()
        const value = stream ? JSON.parse(raw.split("\n")[0].slice(6)) : JSON.parse(raw)
        expect(value.choices[0][stream ? "delta" : "message"].content).toBe("α\nactual result")
        expect(value.choices[0][stream ? "delta" : "message"].tool_calls).toBeUndefined()
        expect(rows[0]).toMatchObject({
          format: ToolEnvelope.schema([], "none"),
          messages: project(history, disabled ? tools : [], true, disabled ? "none" : undefined),
        })
        expect(rows[0]).not.toHaveProperty("tools")
        for (const content of [
          JSON.stringify({ kind: "tool", name: "read", arguments: {} }),
          JSON.stringify({ kind: "tools", calls: [{ name: "question", arguments: {} }], content: "" }),
          JSON.stringify({ kind: "text", content: "result", extra: true }),
          "plain unwrapped text",
        ]) {
          state.content = content
          const err = await send().then(
            () => undefined,
            (err: unknown) => err,
          )
          expect(err).toBeInstanceOf(OllamaBridgeError)
        }
        state.content = JSON.stringify({ kind: "text", content: "result" })
        state.native = true
        const err = await send().then(
          () => undefined,
          (err: unknown) => err,
        )
        expect(err).toBeInstanceOf(OllamaBridgeError)
      } finally {
        end.resolve()
        await server.stop()
      }
    })
  }
}

for (const stream of [false, true]) {
  for (const disabled of [false, true]) {
    for (const format of [
      { type: "json_object" },
      {
        type: "json_schema",
        json_schema: {
          name: "result",
          schema: {
            type: "object",
            properties: { actual: { type: "string" } },
            required: ["actual"],
            additionalProperties: false,
          },
        },
      },
    ]) {
      test(`explicit ${format.type} ${stream ? "stream" : "single"}/${disabled ? "none" : "empty"} retains its requested format`, async () => {
        const rows: unknown[] = []
        const content = JSON.stringify({ actual: "result" })
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(req) {
            rows.push(await req.json())
            return new Response(
              JSON.stringify({
                model: "fixture",
                message: { role: "assistant", content },
                done: true,
                done_reason: "stop",
              }) + (stream ? "\n" : ""),
            )
          },
        })
        try {
          const response = await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, {
            method: "POST",
            body: JSON.stringify({
              model: "fixture",
              messages: history,
              stream,
              tools: disabled ? tools : [],
              ...(disabled ? { tool_choice: "none" } : {}),
              response_format: format,
            }),
          })
          const raw = await response.text()
          const value = stream ? JSON.parse(raw.split("\n")[0].slice(6)) : JSON.parse(raw)
          expect(value.choices[0][stream ? "delta" : "message"].content).toBe(content)
          expect(rows[0]).toMatchObject({
            format: format.type === "json_object" ? "json" : format.json_schema!.schema,
            messages: project(history, disabled ? tools : [], true, disabled ? "none" : undefined, true),
          })
          expect(JSON.stringify(rows[0])).not.toContain(ToolEnvelope.final())
          expect(rows[0]).toMatchObject(disabled ? {} : { tools: [] })
          if (disabled) expect(rows[0]).not.toHaveProperty("tools")
        } finally {
          await server.stop()
        }
      })
    }
  }
}
