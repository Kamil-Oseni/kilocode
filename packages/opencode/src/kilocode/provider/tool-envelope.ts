import z from "zod"

type Tool = { function: { name: string; description?: string; parameters: Record<string, unknown> } }
const call = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()) }).strict()
const serial = new Set(["create_goal", "update_goal", "update_goal_plan", "chief_route"])
const wire = z.discriminatedUnion("kind", [
  call.extend({ kind: z.literal("tool"), content: z.string().optional() }),
  z.object({ kind: z.literal("tools"), calls: z.array(call).min(1).max(128), content: z.string().optional() }).strict(),
  z.object({ kind: z.literal("text"), content: z.string() }).strict(),
])

/** Outer protocol validation only. Tool execution retains semantic/evidence authority. */
export namespace ToolEnvelope {
  export class Empty extends Error {
    constructor() {
      super("Text envelope omitted a reply")
      this.name = "EmptyTextEnvelope"
    }
  }
  export function mode(enabled: boolean, count: number, choice?: "auto" | "required" | "none", structured = false) {
    if (!enabled) return undefined
    if (choice === "required") return "required"
    if (count > 0 && choice !== "none") return choice ?? "auto"
    return structured ? undefined : "none"
  }

  export function final() {
    return (
      "Return exactly one JSON envelope with kind text and content containing the final reply. No tool calls are allowed. " +
      reply()
    )
  }

  export function reply() {
    return "After successful work, obey the user's final-response format. If an exact reply is requested, copy it verbatim, preserving capitalization and whitespace, with no status announcement, summary, or explanation. A Goal complete tool result does not change that reply requirement."
  }

  export function schema(tools: readonly Tool[], choice: "auto" | "required" | "none", refs?: readonly string[]) {
    if (
      refs &&
      (refs.length > 16 ||
        new Set(refs).size !== refs.length ||
        refs.some((value) => !value || Buffer.byteLength(value, "utf8") > 8192))
    )
      throw new Error("Invalid result envelope references")
    if (
      choice !== "none" &&
      (!tools.length || tools.length > 128 || new Set(tools.map((tool) => tool.function.name)).size !== tools.length)
    )
      throw new Error("Invalid envelope tool definitions")
    const calls = (choice === "none" ? [] : tools).map((tool) => {
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
        ...[false, true].flatMap((mutation) => {
          const items = calls.filter((call) => serial.has(call.properties.name.const) === mutation)
          if (!items.length) return []
          return [
            {
              type: "object",
              properties: {
                kind: { const: "tools" },
                calls: { type: "array", items: { anyOf: items }, minItems: 1, maxItems: mutation ? 1 : 128 },
                content: { type: "string" },
              },
              required: ["kind", "calls"],
              additionalProperties: false,
            },
          ]
        }),
        ...(choice !== "required" && (refs === undefined || refs.length > 0)
          ? [
              {
                type: "object",
                properties: {
                  kind: { const: "text" },
                  content:
                    refs === undefined
                      ? { type: "string", minLength: 1, pattern: "\\S" }
                      : { type: "string", enum: [...refs] },
                },
                required: ["kind", "content"],
                additionalProperties: false,
              },
            ]
          : []),
      ],
    }
    if (!value.anyOf.length)
      throw new Error("Result envelope requires completed evidence or eligible acquisition tools")
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error("Envelope schema exceeds bound")
    return value
  }

  export function guide(tools: readonly Tool[]) {
    const value =
      "Return one JSON envelope matching the response schema. Use kind tool (name and arguments), tools (independent calls), or text (content, only when allowed). Calls in one tools envelope can execute concurrently; their array order does not make later calls wait for earlier results. Emit dependent operations in separate envelopes, waiting for the actual result before the next operation. Submit only one update_goal call for the current audit and wait for its result; never duplicate or race Goal status updates. Preserve exact tool arguments. Copy supplied literal filePath values character-for-character from the current request or verified tool output; do not reconstruct paths from memory. Before submitting a tool call, compare the entire decoded path, including its prefix, every directory segment and repeated characters, against that supplied value. JSON escaping must not change the decoded path. Tool results include their original toolCallId and output. Cite only the exact ID of an eligible successful result; never invent an ID. Copy goal criterion IDs and requirement strings from the current get_goal result as decoded text, without rewriting paths, capitalization, or adding JSON escapes. A rejected completion audit leaves the goal active: correct the audit using actual eligible evidence; do not resume an already active goal. " +
      "Submit chief_route alone and wait for its actual routing decision before calling Task or other tools. Never duplicate or race Chief routing calls. " +
      reply() +
      " Tool definitions: " +
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

  export function decode(
    text: string,
    names: ReadonlySet<string>,
    choice: "auto" | "required" | "none",
    refs?: readonly string[],
  ) {
    const value = wire.parse(JSON.parse(text))
    if (value.kind === "text") {
      if (choice === "required") throw new Error("Required envelope omitted tools")
      if (!value.content.trim()) throw new Empty()
      if (refs !== undefined && !refs.includes(value.content))
        throw new Error("Result envelope omitted an eligible source reference")
      return { content: value.content }
    }
    if (choice === "none") throw new Error("Final envelope contains tools")
    const calls = value.kind === "tool" ? [{ name: value.name, arguments: value.arguments }] : value.calls
    if (calls.some((call) => !names.has(call.name))) throw new Error("Unadvertised envelope tool")
    if (calls.length > 1 && calls.some((call) => call.name === "chief_route"))
      throw new Error("Chief routing requires a separate single-call envelope")
    if (calls.length > 1 && calls.some((call) => serial.has(call.name)))
      throw new Error("Goal mutations require a separate single-call envelope")
    return { content: value.content ?? "", tool_calls: calls.map((call) => ({ function: call })) }
  }
}
