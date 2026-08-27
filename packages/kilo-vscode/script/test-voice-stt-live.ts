// raya_change - Milestone H live English/French configured-endpoint accuracy check
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { wordErrorRate } from "../src/speech/accuracy"
import { MiniMaxTts } from "../src/speech/minimax-tts"
import { transcribe } from "../src/speech/openai-stt"

type LocalConfig = {
  providers?: Record<string, { apiKey?: string; baseUrl?: string }>
}

type SpeechConfig = {
  stt?: { endpoint?: string; key?: string; model?: string }
  tts?: { key?: string }
}

type AuthConfig = Record<string, { key?: string }>

const samples = [
  { language: "en", text: "Raya accurately transcribes this English sentence." },
  { language: "fr", text: "Raya transcrit correctement cette phrase en français." },
] as const

async function main() {
  const file = resolve(import.meta.dir, "../../../raya-provider-keys.local.json")
  const config = (await Bun.file(file).json()) as LocalConfig
  const mirror = resolve(import.meta.dir, "../../../.raya/speech.local.json")
  const speech = (await Bun.file(mirror).exists()) ? ((await Bun.file(mirror).json()) as SpeechConfig) : {}
  const authfile = join(homedir(), ".local/share/kilo/auth.json")
  const auth = (await Bun.file(authfile).exists()) ? ((await Bun.file(authfile).json()) as AuthConfig) : {}
  const provider = config.providers?.qwen
  const fallback = provider?.apiKey || auth.qwen?.key
  const base = provider?.baseUrl?.replace(/\/$/, "")
  const endpoint =
    process.env.STT_ENDPOINT ||
    speech.stt?.endpoint ||
    (fallback ? `${base || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"}/chat/completions` : undefined)
  const key = process.env.STT_API_KEY || speech.stt?.key || fallback
  const model =
    process.env.STT_MODEL ||
    speech.stt?.model ||
    (fallback && base ? await discover(base, fallback) : fallback ? "qwen3-asr-flash" : "SenseVoice-Small")
  const ttsKey = process.env.MINIMAX_API_KEY || speech.tts?.key || config.providers?.["minimax-byok"]?.apiKey
  if (!endpoint || !key)
    throw new Error(
      "Live STT is blocked: configure Speech settings and enable its CLI mirror, or set STT_ENDPOINT and STT_API_KEY.",
    )
  if (!ttsKey) throw new Error("MiniMax key is required to generate the known live audio samples.")

  const rows = []
  for (const sample of samples) {
    const audio = await synthesize(ttsKey, sample.text, sample.language)
    const result = await transcribe({
      endpoint,
      key,
      model,
      data: audio.toString("base64"),
      format: "mp3",
      language: sample.language,
    })
    if (!result.ok) throw new Error(`${sample.language} transcription failed: ${result.error}`)
    const error = wordErrorRate(sample.text, result.text)
    if (error > 0.15) throw new Error(`${sample.language} transcription error rate ${error.toFixed(3)} exceeded 0.15.`)
    rows.push({ language: sample.language, expected: sample.text, actual: result.text, error })
  }
  console.log(JSON.stringify({ endpoint: new URL(endpoint).origin, model, samples: rows, passed: true }))
}

async function discover(base: string, key: string) {
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (!response.ok) return "qwen3-asr-flash"
  const body = (await response.json()) as { data?: Array<{ id?: string }> }
  return body.data?.find((item) => item.id?.includes("qwen3-asr-flash"))?.id || "qwen3-asr-flash"
}

function synthesize(key: string, text: string, language: "en" | "fr") {
  const client = new MiniMaxTts()
  const chunks: Buffer[] = []
  return new Promise<Buffer>((resolve, reject) => {
    client.speak(
      {
        id: crypto.randomUUID(),
        endpoint: "wss://api.minimax.io/ws/v1/t2a_v2",
        key,
        model: "speech-2.6-turbo",
        voice: "English_expressive_narrator",
        text,
      },
      {
        chunk: (data) => chunks.push(Buffer.from(data, "base64")),
        done: () => {
          client.dispose()
          resolve(Buffer.concat(chunks))
        },
        error: (error) => {
          client.dispose()
          reject(new Error(error))
        },
      },
    )
  })
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
