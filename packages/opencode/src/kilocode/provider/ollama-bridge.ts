import { schemas } from "./ollama-context"
import { ToolEnvelope } from "./tool-envelope"
import z from "zod"

type Fetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>
const bound = 2 * 1024 * 1024
type Diagnostic = {
  reason:
    | "envelope-json"
    | "envelope-schema"
    | "envelope-validation"
    | "required-acquisition"
    | "ordinary-stream"
    | "required-frame-json"
    | "required-frame-refusal"
  refusal?:
    | "schema"
    | "provider-error"
    | "post-terminal"
    | "model"
    | "finish"
    | "native-tools"
    | "tool-name"
    | "tool-count"
    | "terminal-missing"
    | "tool-missing"
  calls?: number
  nameShape?:
    | "empty"
    | "whitespace-match"
    | "case-match"
    | "namespace-match"
    | "common-unadvertised-read"
    | "other-unadvertised"
  advertisedCount?: number
  envelope?: boolean
  stage?: "read" | "utf8" | "frame" | "eof" | "release"
  error?: "Error" | "TypeError" | "RangeError" | "SyntaxError" | "AbortError" | "TimeoutError" | "other"
  cleanup?: "none" | "cancel" | "release" | "both"
  cancellation?: "same-primary" | "different"
  finish?: string
  prompt?: number
  eval?: number
  bytes: number
  frames: number
  content?: number
}
function metric(value: number | undefined, maximum: number) {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined
}
function shape(name: string, names: ReadonlySet<string>): NonNullable<Diagnostic["nameShape"]> {
  if (!name.trim()) return "empty"
  if (names.has(name.trim())) return "whitespace-match"
  if ([...names].some((value) => value.toLowerCase() === name.toLowerCase())) return "case-match"
  if (
    ["functions.", "function.", "tools."].some(
      (prefix) => name.startsWith(prefix) && names.has(name.slice(prefix.length)),
    )
  )
    return "namespace-match"
  if (["read", "read_file", "functions.read", "functions.read_file"].includes(name)) return "common-unadvertised-read"
  return "other-unadvertised"
}
function decode(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new OllamaBridgeError()
  }
}
function failure(text: string, status: number) {
  const nested = (() => {
    try {
      return z
        .object({
          error: z
            .object({
              code: z.literal(400),
              message: z.string(),
              type: z.literal("exceed_context_size_error"),
              n_prompt_tokens: z.number().int().positive(),
              n_ctx: z.number().int().positive(),
            })
            .strict(),
        })
        .strict()
        .safeParse(JSON.parse(text))
    } catch {
      return undefined
    }
  })()
  const message = nested?.success ? nested.data.error.message : text
  const match =
    /^request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\), try increasing it$/.exec(message)
  const counts =
    match &&
    Number(match[1]) >= Number(match[2]) &&
    (!nested?.success ||
      (nested.data.error.n_prompt_tokens === Number(match[1]) && nested.data.error.n_ctx === Number(match[2])))
  const known =
    counts ||
    message ===
      "the prompt is longer than the context length currently available to the model; shorten the prompt, adjust the context length in settings, or use a model with a longer context length"
  return { message, type: "invalid_request_error", code: status === 400 && known ? "context_length_exceeded" : null }
}
async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  const buffer = { text: "", bytes: 0 }
  try {
    while (true) {
      const chunk = await reader.read()
      buffer.bytes += chunk.value?.byteLength ?? 0
      if (buffer.bytes > bound) throw new OllamaBridgeError()
      buffer.text += decoder.decode(chunk.value, { stream: !chunk.done })
      if (chunk.done) return buffer.text
    }
  } catch (err) {
    await reader.cancel(err)
    throw err
  }
}
const call = z
  .object({
    id: z.string().optional(),
    type: z.literal("function"),
    function: z.object({ name: z.string(), arguments: z.string() }).strict(),
  })
  .strict()
const request = z
  .object({
    model: z.string().min(1),
    messages: z.array(
      z
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
        .refine((message) => message.reasoning_content === undefined || message.role === "assistant"),
    ),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
    store: z.literal(false).optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    seed: z.number().int().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name: z.string(),
                description: z.string().optional(),
                parameters: z.record(z.string(), z.unknown()),
              })
              .strict(),
          })
          .strict(),
      )
      .optional(),
    tool_choice: z.union([z.literal("auto"), z.literal("none"), z.literal("required")]).optional(),
    response_format: z
      .union([
        z.object({ type: z.literal("text") }).strict(),
        z.object({ type: z.literal("json_object") }).strict(),
        z
          .object({
            type: z.literal("json_schema"),
            json_schema: z
              .object({
                name: z.string().optional(),
                strict: z.boolean().optional(),
                schema: z.record(z.string(), z.unknown()),
              })
              .strict(),
          })
          .strict(),
      ])
      .optional(),
    reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional(),
  })
  .strict()
const response = z.object({
  model: z.string(),
  message: z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      thinking: z.string().optional(),
      tool_calls: z
        .array(z.object({ function: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }) }))
        .optional(),
    })
    .optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  prompt_eval_cached_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
})

async function required(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  model: string,
  names: ReadonlySet<string>,
  stream: boolean,
  signal?: AbortSignal | null,
  envelope?: "auto" | "required",
) {
  const rows: z.infer<typeof response>[] = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const state = { bytes: 0, frames: 0, tools: 0, done: false, text: "" }
  const errors: unknown[] = []
  const cleanup = { cancel: false, release: false }
  let stage: Diagnostic["stage"] = "read"
  let failed: Diagnostic["stage"]
  let cancellation: Promise<void> | undefined
  const cancel = (reason: unknown) => {
    cancellation ??= reader.cancel(reason).catch((err: unknown) => {
      cleanup.cancel = true
      errors.push(err)
    })
    return cancellation
  }
  const abort = () => {
    void cancel(signal?.reason)
  }
  const accept = (text: string) => {
    if (++state.frames > 4096) throw new OllamaBridgeError()
    if (!text.trim()) return
    const value = (() => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new OllamaBridgeError({
          diagnostic: {
            reason: "required-frame-json",
            stage: "frame",
            error: "SyntaxError",
            bytes: state.bytes,
            frames: state.frames,
            content: 0,
          },
        })
      }
    })()
    const refuse = (refusal: NonNullable<Diagnostic["refusal"]>, row?: z.infer<typeof response>): never => {
      const call =
        refusal === "tool-name" ? row?.message?.tool_calls?.find((call) => !names.has(call.function.name)) : undefined
      throw new OllamaBridgeError({
        diagnostic: {
          reason: "required-frame-refusal",
          stage: "frame",
          refusal,
          calls: row?.message?.tool_calls?.length,
          ...(call
            ? {
                nameShape: shape(call.function.name, names),
                advertisedCount: names.size,
              }
            : {}),
          envelope: Boolean(envelope),
          finish: row?.done_reason,
          prompt: row?.prompt_eval_count,
          eval: row?.eval_count,
          bytes: state.bytes,
          frames: state.frames,
          content: 0,
        },
      })
    }
    const provider = z.object({ error: z.string() }).safeParse(value)
    if (provider.success && provider.data.error) refuse("provider-error")
    const parsed = response.safeParse(value)
    const row = parsed.success ? parsed.data : refuse("schema")
    if (state.done) refuse("post-terminal", row)
    if (row.model !== model) refuse("model", row)
    if (row.done_reason !== undefined && row.done_reason !== "stop") refuse("finish", row)
    const calls = row.message?.tool_calls ?? []
    if (envelope && calls.length) refuse("native-tools", row)
    if (calls.some((call) => !names.has(call.function.name))) refuse("tool-name", row)
    state.tools += calls.length
    if (state.tools > 128) refuse("tool-count", row)
    state.done = row.done
    rows.push(row)
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    signal?.throwIfAborted()
    while (true) {
      signal?.throwIfAborted()
      stage = "read"
      const chunk = await reader.read()
      signal?.throwIfAborted()
      state.bytes += chunk.value?.byteLength ?? 0
      if (state.bytes > bound) throw new OllamaBridgeError()
      stage = "utf8"
      state.text += decoder.decode(chunk.value, { stream: !chunk.done })
      stage = "frame"
      if (stream) {
        while (true) {
          const end = state.text.indexOf("\n")
          if (end < 0) break
          accept(state.text.slice(0, end))
          state.text = state.text.slice(end + 1)
        }
      }
      if (!chunk.done) continue
      if (state.text.trim()) accept(state.text)
      stage = "eof"
      if (!state.done || (!envelope && !state.tools))
        throw new OllamaBridgeError({
          diagnostic: {
            reason: "required-acquisition",
            stage: "eof",
            refusal: !state.done ? "terminal-missing" : "tool-missing",
            calls: state.tools,
            envelope: Boolean(envelope),
            finish: rows.at(-1)?.done_reason,
            bytes: state.bytes,
            frames: state.frames,
            content: 0,
          },
        })
      signal?.throwIfAborted()
      break
    }
  } catch (err) {
    failed = stage
    errors.unshift(err)
    await cancel(err)
  } finally {
    signal?.removeEventListener("abort", abort)
    await cancellation
    try {
      reader.releaseLock()
    } catch (err) {
      cleanup.release = true
      failed ??= "release"
      errors.push(err)
    }
  }
  const diagnostic = (): Diagnostic => {
    const terminal = rows.at(-1)
    const err = errors[0]
    const original = err instanceof OllamaBridgeError ? err.diagnostic : undefined
    const name = err instanceof Error ? err.name : undefined
    return {
      reason: "required-acquisition",
      ...original,
      stage: failed,
      error:
        original?.error ??
        (name === "Error" ||
        name === "TypeError" ||
        name === "RangeError" ||
        name === "SyntaxError" ||
        name === "AbortError" ||
        name === "TimeoutError"
          ? name
          : "other"),
      cleanup: cleanup.cancel ? (cleanup.release ? "both" : "cancel") : cleanup.release ? "release" : "none",
      finish: terminal?.done_reason ?? (original?.finish === "missing" ? undefined : original?.finish),
      prompt: terminal?.prompt_eval_count ?? original?.prompt,
      eval: terminal?.eval_count ?? original?.eval,
      bytes: state.bytes,
      frames: state.frames,
      content: 0,
    }
  }
  if (errors.length === 1) {
    if (errors[0] instanceof OllamaBridgeError || signal?.aborted) throw errors[0]
    throw new OllamaBridgeError({ cause: errors[0], diagnostic: diagnostic() })
  }
  if (errors.length)
    throw new OllamaBridgeError({
      cause: new AggregateError(errors, "Ollama required response cleanup failed", { cause: errors[0] }),
      diagnostic: diagnostic(),
    })
  signal?.throwIfAborted()
  if (!envelope) return rows
  const content = rows.map((row) => row.message?.content ?? "").join("")
  const message = (() => {
    try {
      return ToolEnvelope.decode(content, names, envelope)
    } catch (err) {
      const terminal = rows.at(-1)!
      throw new OllamaBridgeError({
        diagnostic: {
          reason:
            err instanceof SyntaxError
              ? "envelope-json"
              : err instanceof z.ZodError
                ? "envelope-schema"
                : "envelope-validation",
          finish: terminal.done_reason,
          prompt: terminal.prompt_eval_count,
          eval: terminal.eval_count,
          bytes: state.bytes,
          frames: state.frames,
          content: Buffer.byteLength(content),
        },
      })
    }
  })()
  const thinking = rows.map((row) => row.message?.thinking ?? "").join("")
  return [{ ...rows.at(-1)!, message: { role: "assistant" as const, ...message, ...(thinking ? { thinking } : {}) } }]
}

export class OllamaBridgeError extends Error {
  readonly isRetryable = false
  readonly diagnostic?: Readonly<Partial<Diagnostic>>
  constructor(options?: ErrorOptions & { diagnostic?: Diagnostic }) {
    const row = options?.diagnostic
    const diagnostic = row
      ? {
          reason: [
            "envelope-json",
            "envelope-schema",
            "envelope-validation",
            "required-acquisition",
            "ordinary-stream",
            "required-frame-json",
            "required-frame-refusal",
          ].includes(row.reason)
            ? row.reason
            : "envelope-validation",
          ...(row.refusal
            ? {
                refusal: [
                  "schema",
                  "provider-error",
                  "post-terminal",
                  "model",
                  "finish",
                  "native-tools",
                  "tool-name",
                  "tool-count",
                  "terminal-missing",
                  "tool-missing",
                ].includes(row.refusal)
                  ? row.refusal
                  : undefined,
              }
            : {}),
          calls: metric(row.calls, 4096),
          ...(row.nameShape
            ? {
                nameShape: [
                  "empty",
                  "whitespace-match",
                  "case-match",
                  "namespace-match",
                  "common-unadvertised-read",
                  "other-unadvertised",
                ].includes(row.nameShape)
                  ? row.nameShape
                  : undefined,
              }
            : {}),
          advertisedCount: metric(row.advertisedCount, 4096),
          ...(typeof row.envelope === "boolean" ? { envelope: row.envelope } : {}),
          ...(row.stage
            ? { stage: ["read", "utf8", "frame", "eof", "release"].includes(row.stage) ? row.stage : undefined }
            : {}),
          ...(row.error
            ? {
                error: [
                  "Error",
                  "TypeError",
                  "RangeError",
                  "SyntaxError",
                  "AbortError",
                  "TimeoutError",
                  "other",
                ].includes(row.error)
                  ? row.error
                  : "other",
              }
            : {}),
          ...(row.cleanup
            ? { cleanup: ["none", "cancel", "release", "both"].includes(row.cleanup) ? row.cleanup : undefined }
            : {}),
          ...(row.cancellation
            ? { cancellation: ["same-primary", "different"].includes(row.cancellation) ? row.cancellation : undefined }
            : {}),
          finish: row.finish === undefined ? "missing" : ["stop", "length"].includes(row.finish) ? row.finish : "other",
          prompt: metric(row.prompt, 2_147_483_647),
          eval: metric(row.eval, 2_147_483_647),
          bytes: metric(row.bytes, bound),
          frames: metric(row.frames, 4096),
          content: metric(row.content, bound),
        }
      : undefined
    super(
      "Unsupported or invalid Ollama bridge request or response" +
        (diagnostic ? ` [${JSON.stringify(diagnostic)}]` : ""),
      options,
    )
    this.name = "OllamaBridgeError"
    this.diagnostic = diagnostic
  }
}

/** Explicit protocol selection only; local resource admission alone never rewrites endpoints. */
export function ollama(options: Readonly<Record<string, unknown>>, fetcher: Fetch): Fetch {
  if (options.localInferenceAPI === undefined) return fetcher
  if (options.localInferenceAPI !== "ollama" || options.localInference !== true) throw new OllamaBridgeError()
  const context = options.localInferenceContext
  const idle = options.localInferenceKeepAlive
  if (
    context !== undefined &&
    (typeof context !== "number" || !Number.isSafeInteger(context) || context < 2048 || context > 262144)
  )
    throw new OllamaBridgeError()
  if (context !== undefined && options.ollamaContext !== undefined && context !== options.ollamaContext)
    throw new OllamaBridgeError()
  if (idle !== undefined && (typeof idle !== "number" || !Number.isSafeInteger(idle) || idle < 0 || idle > 600))
    throw new OllamaBridgeError()
  if (options.localInferenceToolFormat !== undefined && options.localInferenceToolFormat !== "completion-envelope-v1")
    throw new OllamaBridgeError()
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (
      !url.pathname.endsWith("/chat/completions") ||
      (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST"
    )
      throw new OllamaBridgeError()
    const body = (() => {
      const value = init?.body
      if (typeof value === "string") {
        if (Buffer.byteLength(value) > bound) throw new OllamaBridgeError()
        return value
      }
      const bytes =
        value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined
      if (!bytes || bytes.byteLength > bound) throw new OllamaBridgeError()
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new OllamaBridgeError()
      }
    })()
    const parsed = request.safeParse(decode(body))
    if (!parsed.success) throw new OllamaBridgeError({ cause: parsed.error })
    const data = parsed.data
    if (options.ollamaModel !== undefined && data.model !== options.ollamaModel) throw new OllamaBridgeError()
    if (
      options.ollamaContext !== undefined &&
      (typeof options.ollamaContext !== "number" ||
        !Number.isSafeInteger(options.ollamaContext) ||
        options.ollamaContext <= 0)
    )
      throw new OllamaBridgeError()
    const advertised = new Set(data.tools?.map((tool) => tool.function.name))
    if (
      data.tool_choice === "required" &&
      (!data.tools?.length || advertised.size !== data.tools.length || [...advertised].some((name) => !name.trim()))
    )
      throw new OllamaBridgeError()
    const envelope =
      options.localInferenceToolFormat === "completion-envelope-v1" &&
      (advertised.has("update_goal") ||
        (data.tool_choice === "required" && advertised.size === 1 && advertised.has("chief_route"))) &&
      data.tool_choice !== "none"
        ? (data.tool_choice ?? "auto")
        : undefined
    if (envelope && data.response_format && data.response_format.type !== "text") throw new OllamaBridgeError()
    const originals = envelope ? schemas(options) : undefined
    if (originals) {
      if (
        originals.length !== advertised.size ||
        new Set(originals.map((row) => row.name)).size !== originals.length ||
        originals.some((row) => !advertised.has(row.name))
      )
        throw new OllamaBridgeError()
      data.tools = data.tools!.map((tool) => {
        const original = originals.find((row) => row.name === tool.function.name)
        if (!original) throw new OllamaBridgeError()
        return { ...tool, function: { ...tool.function, parameters: original.parameters } }
      })
    }
    const format = envelope ? ToolEnvelope.schema(data.tools!, envelope) : undefined
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const names = new Map(
      data.messages.flatMap(
        (message) =>
          message.tool_calls?.flatMap((tool) => (tool.id ? [[tool.id, tool.function.name] as const] : [])) ?? [],
      ),
    )
    const messages = data.messages.map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.map((part) => part.text).join("")
        : (message.content ?? "")
      const calls = message.tool_calls?.map((tool) => {
        const args = decode(tool.function.arguments)
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new OllamaBridgeError()
        return { function: { name: tool.function.name, arguments: args } }
      })
      const name =
        message.role === "tool"
          ? (message.name ?? (message.tool_call_id ? names.get(message.tool_call_id) : undefined))
          : undefined
      if (message.role === "tool" && !name) throw new OllamaBridgeError()
      return {
        role: message.role,
        content:
          envelope && message.role === "tool" && message.tool_call_id
            ? JSON.stringify({ toolCallId: message.tool_call_id, output: content })
            : content,
        ...(message.reasoning_content !== undefined ? { thinking: message.reasoning_content } : {}),
        ...(calls ? { tool_calls: calls } : {}),
        ...(name ? { tool_name: name } : {}),
      }
    })
    if (data.tool_choice === "required") {
      const guide =
        "For this response, call at least one tool from the supplied tools list. Do not return a text-only answer."
      const system = messages.find((message) => message.role === "system")
      if (system) system.content += "\n\n" + guide
      if (!system) messages.unshift({ role: "system", content: guide })
    }
    if (envelope) {
      const guide = ToolEnvelope.guide(data.tools!)
      const system = messages.find((message) => message.role === "system")
      if (system) system.content += "\n\n" + guide
      if (!system) messages.unshift({ role: "system", content: guide })
    }
    url.pathname = "/api/chat"
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.delete("content-length")
    headers.set("content-type", "application/json")
    // Required verification owns the entire fetch/read phase, including terminal-to-EOF waits.
    const controller = data.tool_choice === "required" || envelope ? new AbortController() : undefined
    const duration =
      typeof options.timeout === "number" && Number.isFinite(options.timeout) && options.timeout > 0
        ? Math.min(options.timeout, 300_000)
        : 300_000
    const signal = controller ? AbortSignal.any([controller.signal, ...(caller ? [caller] : [])]) : caller
    const timer = controller ? setTimeout(() => controller.abort(new OllamaBridgeError()), duration) : undefined
    try {
      if (controller) signal?.throwIfAborted()
      const payload = JSON.stringify({
        model: data.model,
        messages,
        stream: data.stream ?? false,
        ...(idle !== undefined ? { keep_alive: idle } : {}),
        ...(format ? { format } : {}),
        shift: false,
        truncate: false,
        ...(!envelope && data.tools && data.tool_choice !== "none" ? { tools: data.tools } : {}),
        ...(data.reasoning_effort ? { think: data.reasoning_effort === "none" ? false : data.reasoning_effort } : {}),
        ...(data.response_format?.type === "json_object" ? { format: "json" } : {}),
        ...(data.response_format?.type === "json_schema" ? { format: data.response_format.json_schema.schema } : {}),
        options: {
          ...(options.ollamaContext !== undefined || context !== undefined
            ? { num_ctx: options.ollamaContext ?? context }
            : {}),
          ...(data.max_tokens ? { num_predict: data.max_tokens } : {}),
          ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
          ...(data.top_p !== undefined ? { top_p: data.top_p } : {}),
          ...(data.seed !== undefined ? { seed: data.seed } : {}),
          ...(data.frequency_penalty !== undefined ? { frequency_penalty: data.frequency_penalty } : {}),
          ...(data.presence_penalty !== undefined ? { presence_penalty: data.presence_penalty } : {}),
          ...(data.stop ? { stop: typeof data.stop === "string" ? [data.stop] : data.stop } : {}),
        },
      })
      if (envelope && Buffer.byteLength(payload) > bound) throw new OllamaBridgeError()
      const native = await fetcher(url, {
        ...init,
        ...(controller && signal ? { signal } : {}),
        headers,
        body: payload,
      })
      if (!native.ok) {
        if (!native.body) throw new OllamaBridgeError()
        const parsed = z.object({ error: z.string().max(bound) }).safeParse(decode(await read(native.body.getReader())))
        if (!parsed.success) throw new OllamaBridgeError()
        return Response.json({ error: failure(parsed.data.error, native.status) }, { status: native.status })
      }
      const id = `chatcmpl-${crypto.randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const state = { tools: 0, done: false }
      const convert = (raw: unknown) => {
        const parsed = response.safeParse(raw)
        if (!parsed.success || parsed.data.error) throw new OllamaBridgeError()
        const row = parsed.data
        const tools = row.message?.tool_calls?.map((tool) => {
          const index = state.tools++
          return {
            index,
            id: `${id}-tool-${index}`,
            type: "function",
            function: { name: tool.function.name, arguments: JSON.stringify(tool.function.arguments) },
          }
        })
        const message = {
          ...(row.message?.content ? { content: row.message.content } : {}),
          ...(row.message?.thinking ? { reasoning_content: row.message.thinking } : {}),
          ...(tools ? { tool_calls: tools } : {}),
        }
        const finish = row.done ? (state.tools ? "tool_calls" : row.done_reason === "length" ? "length" : "stop") : null
        state.done ||= row.done
        return {
          id,
          object: data.stream ? "chat.completion.chunk" : "chat.completion",
          created,
          model: row.model,
          choices: [
            {
              index: 0,
              ...(data.stream ? { delta: message } : { message: { role: "assistant", content: "", ...message } }),
              finish_reason: finish,
            },
          ],
          ...(row.done &&
          (data.tool_choice !== "required" || (row.prompt_eval_count !== undefined && row.eval_count !== undefined))
            ? {
                usage: {
                  prompt_tokens: row.prompt_eval_count ?? 0,
                  completion_tokens: row.eval_count ?? 0,
                  total_tokens: (row.prompt_eval_count ?? 0) + (row.eval_count ?? 0),
                  ...(row.prompt_eval_cached_count !== undefined
                    ? { prompt_tokens_details: { cached_tokens: row.prompt_eval_cached_count } }
                    : {}),
                },
              }
            : {}),
        }
      }
      if (!native.body) throw new OllamaBridgeError()
      const reader = native.body.getReader()
      if (data.tool_choice === "required" || envelope) {
        const rows = await required(reader, data.model, advertised, data.stream === true, signal, envelope)
        signal?.throwIfAborted()
        const values = rows.map(convert)
        if (!data.stream) return Response.json(values[0])
        const encoder = new TextEncoder()
        const frames = values.map((value) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
        if (frames.reduce((bytes, frame) => bytes + frame.byteLength, 0) > bound * 8) throw new OllamaBridgeError()
        signal?.throwIfAborted()
        let index = 0
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            try {
              signal?.throwIfAborted()
              if (index < frames.length) {
                controller.enqueue(frames[index++])
                return
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
            } catch (err) {
              controller.error(err)
            }
          },
          cancel() {
            index = frames.length
            frames.length = 0
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      const decoder = new TextDecoder()
      if (!data.stream) {
        const value = convert(decode(await read(reader)))
        if (!state.done) throw new OllamaBridgeError()
        return Response.json(value)
      }
      const encoder = new TextEncoder()
      const pending = { text: "", bytes: 0, frames: 0 }
      let stage: Diagnostic["stage"] = "read"
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (true) {
              const line = pending.text.indexOf("\n")
              if (line >= 0) {
                const text = pending.text.slice(0, line)
                pending.text = pending.text.slice(line + 1)
                if (!text.trim()) continue
                stage = "frame"
                pending.frames++
                if (state.done) throw new OllamaBridgeError()
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(convert(decode(text)))}\n\n`))
                return
              }
              stage = "read"
              const chunk = await reader.read()
              pending.bytes += chunk.value?.byteLength ?? 0
              pending.text += decoder.decode(chunk.value, { stream: !chunk.done })
              if (Buffer.byteLength(pending.text) > bound) throw new OllamaBridgeError()
              if (!chunk.done) continue
              stage = "eof"
              if (pending.text.trim()) {
                pending.frames++
                if (state.done) throw new OllamaBridgeError()
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(convert(decode(pending.text)))}\n\n`))
              }
              if (!state.done) throw new OllamaBridgeError()
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
              return
            }
          } catch (err) {
            const closed = await reader.cancel(err).then(
              () => ({ ok: true as const }),
              (failure: unknown) => ({ ok: false as const, failure }),
            )
            const name = err instanceof Error ? err.name : undefined
            controller.error(
              new OllamaBridgeError({
                cause: closed.ok
                  ? err
                  : new AggregateError([err, closed.failure], "Ollama stream cleanup failed", { cause: err }),
                diagnostic: {
                  reason: "ordinary-stream",
                  stage,
                  error:
                    name === "Error" ||
                    name === "TypeError" ||
                    name === "RangeError" ||
                    name === "SyntaxError" ||
                    name === "AbortError" ||
                    name === "TimeoutError"
                      ? name
                      : "other",
                  cleanup: closed.ok ? "none" : "cancel",
                  ...(!closed.ok
                    ? { cancellation: closed.failure === err ? ("same-primary" as const) : ("different" as const) }
                    : {}),
                  bytes: pending.bytes,
                  frames: pending.frames,
                },
              }),
            )
          }
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    } catch (err) {
      if (controller?.signal.aborted && !caller?.aborted && !(err instanceof OllamaBridgeError))
        throw new OllamaBridgeError({ cause: err })
      if ((!envelope && data.tool_choice !== "required") || err instanceof OllamaBridgeError || signal?.aborted)
        throw err
      throw new OllamaBridgeError({ cause: err })
    } finally {
      clearTimeout(timer)
    }
  }
}
