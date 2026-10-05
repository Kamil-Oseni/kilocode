import z from "zod"

type Tool = { function: { name: string; description?: string; parameters: Record<string, unknown> } }
const call = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).strict()
const wire = z.discriminatedUnion("kind", [
  call.extend({ kind: z.literal("tool"), content: z.string().optional() }),
  z.object({ kind: z.literal("tools"), calls: z.array(call).min(1).max(128), content: z.string().optional() }).strict(),
  z.object({ kind: z.literal("text"), content: z.string() }).strict(),
])

/** Outer protocol validation only. Tool execution retains semantic/evidence authority. */
export namespace ToolEnvelope {
  export function schema(tools: readonly Tool[], choice: "auto" | "required") {
    if (!tools.length || tools.length > 128 || new Set(tools.map((tool) => tool.function.name)).size !== tools.length)
      throw new Error("Invalid envelope tool definitions")
    const calls = tools.map((tool) => {
      if (!tool.function.name.trim()) throw new Error("Invalid envelope tool name")
      return {
        type: "object",
        properties: { name: { const: tool.function.name }, arguments: tool.function.parameters },
        required: ["name", "arguments"],
        additionalProperties: false,
      }
    })
    const value = {
      anyOf: [
        ...calls.map((call) => ({
          ...call,
          properties: { ...call.properties, kind: { const: "tool" }, content: { type: "string" } },
          required: [...call.required, "kind"],
        })),
        {
          type: "object",
          properties: {
            kind: { const: "tools" },
            calls: { type: "array", items: { anyOf: calls }, minItems: 1, maxItems: 128 },
            content: { type: "string" },
          },
          required: ["kind", "calls"],
          additionalProperties: false,
        },
        ...(choice === "auto"
          ? [
              {
                type: "object",
                properties: { kind: { const: "text" }, content: { type: "string" } },
                required: ["kind", "content"],
                additionalProperties: false,
              },
            ]
          : []),
      ],
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error("Envelope schema exceeds bound")
    return value
  }

  export function guide(tools: readonly Tool[]) {
    const value =
      "Return one JSON envelope matching the response schema. Use kind tool (name and arguments), tools (ordered calls), or text (content, only when allowed). Preserve exact tool arguments. Tool results include their original toolCallId and output. Cite only the exact ID of an eligible successful result; never invent an ID. Preserve saved goal requirement strings as decoded text, without adding JSON escapes. Tool definitions: " +
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      )
    if (Buffer.byteLength(value) > 128 * 1024) throw new Error("Envelope instructions exceed bound")
    return value
  }

  export function decode(text: string, names: ReadonlySet<string>, choice: "auto" | "required") {
    const value = wire.parse(JSON.parse(text))
    if (value.kind === "text") {
      if (choice !== "auto") throw new Error("Required envelope omitted tools")
      return { content: value.content }
    }
    const calls = value.kind === "tool" ? [{ name: value.name, arguments: value.arguments }] : value.calls
    if (calls.some((call) => !names.has(call.name))) throw new Error("Unadvertised envelope tool")
    return { content: value.content ?? "", tool_calls: calls.map((call) => ({ function: call })) }
  }
}
