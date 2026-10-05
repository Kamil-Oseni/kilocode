// raya_change - Milestone H configurable OpenAI-compatible transcription client
import { getErrorMessage } from "../kilo-provider-utils"

export type SttInput = {
  endpoint: string
  key: string
  model: string
  data: string
  format: string
  language?: string
  local?: boolean
}

export type SttResult = { ok: true; text: string } | { ok: false; error: string; code?: string }

export async function transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult> {
  if (!input.endpoint)
    return { ok: false, error: "Configure an STT endpoint in Speech settings.", code: "not_configured" }
  if (!input.key) return { ok: false, error: "Add the STT API key in Speech settings.", code: "not_authenticated" }
  if (input.local && !loopback(input)) return { ok: false, error: "Invalid local transcription request." }
  const chat = /\/chat\/completions\/?(?:\?|$)/.test(input.endpoint)
  const payload = chat ? JSON.stringify(qwen(input)) : multipart(input)

  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      signal: scope(input.local, signal),
      redirect: input.local ? "error" : "follow",
      headers: {
        Authorization: `Bearer ${input.key}`,
        ...(chat ? { "Content-Type": "application/json" } : {}),
      },
      body: payload,
    })
    const raw = input.local ? await bounded(response) : await response.text()
    const body = parse(raw)
    if (!response.ok) return rejected(input.local, response.status, body, raw)
    const text = transcript(body)
    if (!text) return { ok: false, error: "No speech was detected.", code: "empty_transcript" }
    return { ok: true, text }
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "Speech transcription cancelled.", code: "cancelled" }
    return {
      ok: false,
      error: input.local
        ? "Local transcription request failed."
        : getErrorMessage(err) || "Speech transcription request failed.",
    }
  }
}

function loopback(input: SttInput) {
  try {
    const url = new URL(input.endpoint)
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/v1/audio/transcriptions" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      input.model === "whisper-small.en" &&
      input.data.length <= 16_000_000
    )
  } catch {
    return false
  }
}

function scope(local: boolean | undefined, signal?: AbortSignal) {
  if (!local) return signal
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180_000)])
}

async function bounded(response: Response) {
  if (!response.body) throw new Error("Empty local transcription response.")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const row = await reader.read()
      if (row.done) break
      size += row.value.length
      if (size > 262_144) throw new Error("Local transcription response exceeds its bound.")
      chunks.push(row.value)
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

function multipart(input: SttInput) {
  const form = new FormData()
  const bytes = Buffer.from(input.data, "base64")
  form.append("file", new Blob([bytes], { type: mime(input.format) }), `speech.${extension(input.format)}`)
  form.append("model", input.model)
  if (input.language) form.append("language", input.language)
  form.append(
    "prompt",
    "Transcribe exactly what is spoken. Preserve the original language, wording, names, punctuation, and incomplete phrases.",
  )
  return form
}

// Qwen3-ASR exposes its OpenAI-compatible transport through chat/completions rather than audio/transcriptions.
function qwen(input: SttInput) {
  return {
    model: input.model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: `data:${mime(input.format)};base64,${input.data}` },
          },
        ],
      },
    ],
    stream: false,
    asr_options: { language: input.language, enable_itn: true },
  }
}

function transcript(body: Record<string, unknown> | undefined) {
  if (typeof body?.text === "string") return body.text.trim()
  const choices = body?.choices
  if (!Array.isArray(choices)) return ""
  const first = choices[0]
  if (!first || typeof first !== "object") return ""
  const reply = (first as Record<string, unknown>).message
  if (!reply || typeof reply !== "object") return ""
  const text = (reply as Record<string, unknown>).content
  return typeof text === "string" ? text.trim() : ""
}

function mime(format: string) {
  if (format.includes("webm")) return "audio/webm"
  if (format.includes("wav")) return "audio/wav"
  if (format.includes("mp3")) return "audio/mpeg"
  return "audio/mp4"
}

function extension(format: string) {
  if (format.includes("webm")) return "webm"
  if (format.includes("wav")) return "wav"
  if (format.includes("mp3")) return "mp3"
  return "m4a"
}

function parse(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    console.error("[Raya] STT response parsing failed:", err)
    return undefined
  }
}

function message(body: Record<string, unknown> | undefined, raw: string): string | undefined {
  const error = body?.error
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const value = (error as Record<string, unknown>).message
    if (typeof value === "string") return value
  }
  if (typeof body?.message === "string") return body.message
  return raw.trim() || undefined
}

function rejected(
  local: boolean | undefined,
  status: number,
  body: Record<string, unknown> | undefined,
  raw: string,
): SttResult {
  const auth = status === 401 || status === 403
  const failure = local && !auth && body ? localError(body) : undefined
  if (failure) return failure
  return {
    ok: false,
    error: local
      ? `Local transcription failed with status ${status}.`
      : (message(body, raw) ?? `Speech transcription failed with status ${status}.`),
    code: auth ? "not_authenticated" : undefined,
  }
}

function localError(body: Record<string, unknown>): SttResult | undefined {
  const error = body.error
  if (!error || typeof error !== "object" || Array.isArray(error)) return
  const code = (error as Record<string, unknown>).code
  if (typeof code !== "string") return
  const messages: Record<string, string> = {
    empty_transcript: "No speech was detected.",
    invalid_audio: "The recording could not be read. Record again.",
    audio_too_long: "The recording is too long. Record a shorter message.",
    unsupported_model: "The configured local transcription model is unavailable.",
    inference_failed: "Local transcription failed. Try recording again.",
  }
  if (!Object.hasOwn(messages, code)) return
  return { ok: false, error: messages[code], code }
}
