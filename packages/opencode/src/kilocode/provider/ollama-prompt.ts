import z from "zod"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { standardizePrompt, convertToLanguageModelPrompt } from "ai/internal"
import { convertToOpenAICompatibleChatMessages } from "@ai-sdk/openai-compatible/internal"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { structured } from "./ollama-context"
import { ToolEnvelope } from "./tool-envelope"

const call = z
  .object({
    id: z.string().optional(),
    type: z.literal("function"),
    function: z.object({ name: z.string(), arguments: z.string() }).strict(),
  })
  .strict()
export const message = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z
      .union([z.string(), z.null(), z.array(z.object({ type: z.literal("text"), text: z.string() }).strict())])
      .optional(),
    tool_calls: z.array(call).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    reasoning_content: z.string().optional(),
  })
  .strict()
  .refine((value) => value.reasoning_content === undefined || value.role === "assistant")

export class OllamaWindowError extends Error {
  readonly isRetryable = false
  constructor(cause?: unknown) {
    super(
      "The final local request exceeds its configured context or envelope capacity. Reduce conversation history or selected tools; fixed instructions are never truncated.",
      { cause },
    )
    this.name = "OllamaWindowError"
  }
}

class OllamaPromptError extends Error {
  readonly isRetryable = false
  constructor(cause?: unknown) {
    super("The local request contains unsupported native prompt content.", { cause })
    this.name = "OllamaPromptError"
  }
}

function capacity<T>(read: () => T) {
  try {
    return read()
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === "Envelope instructions exceed bound" || err.message === "Envelope schema exceeds bound")
    )
      throw new OllamaWindowError(err)
    throw err
  }
}

export function format(tools: Parameters<typeof ToolEnvelope.schema>[0], choice: "auto" | "required" | "none") {
  if (
    choice !== "none" &&
    tools.length > 128 &&
    new Set(tools.map((tool) => tool.function.name)).size === tools.length &&
    tools.every((tool) => tool.function.name.trim())
  )
    throw new OllamaWindowError()
  return capacity(() => ToolEnvelope.schema(tools, choice))
}

/** One projection owns native history escaping and all envelope instructions. */
export function project(
  rows: z.infer<typeof message>[],
  tools: Parameters<typeof ToolEnvelope.guide>[0],
  protocol: boolean,
  choice?: "auto" | "required" | "none",
  output = false,
) {
  const names = new Map(
    rows.flatMap(
      (row) => row.tool_calls?.flatMap((call) => (call.id ? [[call.id, call.function.name] as const] : [])) ?? [],
    ),
  )
  const messages = rows.map((row) => {
    const content = Array.isArray(row.content) ? row.content.map((part) => part.text).join("") : (row.content ?? "")
    const calls = row.tool_calls?.map((call) => {
      const args: unknown = JSON.parse(call.function.arguments)
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new OllamaPromptError()
      return { function: { name: call.function.name, arguments: args } }
    })
    const name =
      row.role === "tool" ? (row.name ?? (row.tool_call_id ? names.get(row.tool_call_id) : undefined)) : undefined
    if (row.role === "tool" && !name) throw new OllamaPromptError()
    return {
      role: row.role,
      content:
        protocol && row.role === "assistant" && calls?.length
          ? JSON.stringify({ kind: "tools", calls: calls.map((call) => call.function), content })
          : protocol && row.role === "tool" && row.tool_call_id
            ? JSON.stringify({ toolCallId: row.tool_call_id, output: content })
            : content,
      ...(row.reasoning_content !== undefined ? { thinking: row.reasoning_content } : {}),
      ...(calls && !(protocol && row.role === "assistant") ? { tool_calls: calls } : {}),
      ...(name ? { tool_name: name } : {}),
    }
  })
  const append = (guide: string) => {
    const system = messages.find((row) => row.role === "system")
    if (system) system.content += "\n\n" + guide
    if (!system) messages.unshift({ role: "system", content: guide })
  }
  if (choice === "required")
    append("For this response, call at least one tool from the supplied tools list. Do not return a text-only answer.")
  if (protocol) {
    const mode = ToolEnvelope.mode(protocol, tools.length, choice, output)
    append(
      mode === "none" ? ToolEnvelope.final() : mode ? capacity(() => ToolEnvelope.guide(tools)) : ToolEnvelope.reply(),
    )
  }
  return messages
}

export function measure(messages: ReturnType<typeof project>, tools: Parameters<typeof ToolEnvelope.guide>[0]) {
  return KiloSessionOverflow.measure({
    messages,
    tools: Object.fromEntries(
      tools.map((row) => [
        row.function.name,
        { description: row.function.description, inputSchema: row.function.parameters },
      ]),
    ),
  })
}

/** Generic estimates retain their tokenizer accuracy limit; this uses the actual SDK lowering, without downloading media. */
export async function prepare(
  options: Readonly<Record<string, unknown>>,
  model: Provider.Model,
  messages: ModelMessage[],
  tools: Record<string, Tool>,
  choice?: "auto" | "required" | "none",
  transform: Record<string, unknown> = options,
  output = false,
) {
  if (!structured(options, model.api.npm)) return undefined
  const prompt = await standardizePrompt({ messages, allowSystemInMessages: true })
  const lowered = await convertToLanguageModelPrompt({
    prompt,
    supportedUrls: {},
    download: async (rows) => {
      if (rows.length) throw new OllamaPromptError()
      return []
    },
  })
  // The existing SDK middleware applies this ModelMessage-typed transform to
  // its lowered prompt. Copy here so estimating never mutates transmitted history.
  const adapted = ProviderTransform.message(structuredClone(lowered) as unknown as ModelMessage[], model, transform)
  const rows = message.array().parse(convertToOpenAICompatibleChatMessages(adapted as unknown as typeof lowered))
  const definitions = Object.entries(tools).map(([name, tool]) => ({
    function: {
      name,
      description: tool.description,
      parameters: z.record(z.string(), z.unknown()).parse(asSchema(tool.inputSchema).jsonSchema),
    },
  }))
  const protocol = options.localInferenceToolFormat === "completion-envelope-v1"
  const mode = ToolEnvelope.mode(protocol, definitions.length, choice, output)
  if (mode) format(definitions, mode)
  const frame = project(rows, definitions, protocol, choice, output)
  const selected = mode || choice === "none" ? [] : definitions
  const budget = Object.fromEntries(
    selected.map((row) => [
      row.function.name,
      { description: row.function.description, inputSchema: row.function.parameters },
    ]),
  )
  return { messages: frame, tools: selected, budget, usage: measure(frame, selected) }
}

export function check(
  messages: ReturnType<typeof project>,
  tools: Parameters<typeof ToolEnvelope.guide>[0],
  context: number | undefined,
  output: number | undefined,
) {
  if (!context) return
  if (!output || measure(messages, tools).normalized + output > context) throw new OllamaWindowError()
}
