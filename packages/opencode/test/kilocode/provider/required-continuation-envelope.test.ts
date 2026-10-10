import { expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { context, schemas } from "@/kilocode/provider/ollama-context"
import { ollama, OllamaBridgeError } from "@/kilocode/provider/ollama-bridge"

test("required and automatic continuation tools retain the configured envelope and immutable schemas", async () => {
  const original = {
    type: "object" as const,
    properties: { task_id: { type: "string" as const } },
    required: ["task_id"],
  }
  const tools = {
    inspect_task: tool({ inputSchema: jsonSchema(original) }),
    get_goal: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) }),
  }
  const cfg = context(
    { localInference: true, localInferenceAPI: "ollama", localInferenceToolFormat: "completion-envelope-v1" },
    { api: { id: "fixture" }, limit: { context: 32768 } },
    tools,
  )
  const rows: { format?: { anyOf: { properties: { arguments?: unknown } }[] }; tools?: unknown }[] = []
  const state = { content: JSON.stringify({ kind: "tool", name: "inspect_task", arguments: { task_id: "fixture" } }) }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      rows.push(await req.json())
      return new Response(
        JSON.stringify({
          model: "fixture",
          message: { role: "assistant", content: state.content },
          done: true,
          done_reason: "stop",
        }) + "\n",
      )
    },
  })
  const request = (stream: boolean, choice: "required" | "auto" | undefined) => ({
    method: "POST",
    body: JSON.stringify({
      model: "fixture",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Continue the delegated task" }],
      tools: Object.keys(tools).map((name) => ({ type: "function", function: { name, parameters: {} } })),
      tool_choice: choice,
      stream,
    }),
  })
  try {
    for (const choice of ["required", "auto", undefined] as const) {
      for (const stream of [false, true]) {
        const response = await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, request(stream, choice))
        const text = await response.text()
        const value = stream ? JSON.parse(text.split("\n")[0].slice(6)) : JSON.parse(text)
        const call = value.choices[0][stream ? "delta" : "message"].tool_calls[0]
        expect(call.function.name).toBe("inspect_task")
        expect(JSON.parse(call.function.arguments)).toEqual({ task_id: "fixture" })
        expect(rows.at(-1)!.tools).toBeUndefined()
        expect(rows.at(-1)!.format!.anyOf[0].properties.arguments).toEqual(original)
      }
    }
    expect(schemas(cfg)).toEqual([
      { name: "inspect_task", parameters: original },
      { name: "get_goal", parameters: { type: "object", properties: {} } },
    ])
    state.content = JSON.stringify({ kind: "text", content: "premature completion" })
    const err = await ollama(cfg, fetch)(`${server.url}v1/chat/completions`, request(true, "required")).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(err).toBeInstanceOf(OllamaBridgeError)
  } finally {
    await server.stop()
  }
})
