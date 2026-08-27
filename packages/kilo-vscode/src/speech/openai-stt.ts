// raya_change - Milestone H configurable OpenAI-compatible transcription client
import { getErrorMessage } from "../kilo-provider-utils"

export type SttInput = {
  endpoint: string
  key: string
  model: string
  data: string
  format: string
  language?: string
}

export type SttResult = { ok: true; text: string } | { ok: false; error: string; code?: string }

export async function transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult> {
  if (!input.endpoint)
    return { ok: false, error: "Configure an STT endpoint in Speech settings.", code: "not_configured" }
  if (!input.key) return { ok: false, error: "Add the STT API key in Speech settings.", code: "not_authenticated" }
  const chat = /\/chat\/completions\/?(?:\?|$)/.test(input.endpoint)
  const payload = chat ? JSON.stringify(qwen(input)) : multipart(input)

  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${input.key}`,
        ...(chat ? { "Content-Type": "application/json" } : {}),
      },
      body: payload,
    })
    const raw = await response.text()
    const body = parse(raw)
    if (!response.ok) {
      return {
        ok: false,
        error: message(body, raw) ?? `Speech transcription failed with status ${response.status}.`,
        code: response.status === 401 || response.status === 403 ? "not_authenticated" : undefined,
      }
    }
    const text = transcript(body)
    if (!text) return { ok: false, error: "No speech was detected.", code: "empty_transcript" }
    return { ok: true, text }
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: "Speech transcription cancelled.", code: "cancelled" }
    return { ok: false, error: getErrorMessage(err) || "Speech transcription request failed." }
  }
}

function multipart(input: SttInput) {
  const form = new FormData()
  const bytes = Buffer.from(input.data, "base64")
  form.append("file", new Blob([bytes]), `speech.${extension(input.format)}`)
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
    console.error("[Kilo New] STT response parsing failed:", err)
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
