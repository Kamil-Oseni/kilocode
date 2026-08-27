// raya_change - Milestone H funded MiniMax streaming latency check
import { resolve } from "node:path"
import { MiniMaxTts, type TtsResult } from "../src/speech/minimax-tts"

type LocalConfig = {
  providers?: Record<string, { apiKey?: string }>
}

async function main() {
  const file = resolve(import.meta.dir, "../../../raya-provider-keys.local.json")
  const config = (await Bun.file(file).json()) as LocalConfig
  const key = process.env.MINIMAX_API_KEY || config.providers?.["minimax-byok"]?.apiKey
  if (!key) throw new Error("MiniMax key missing from MINIMAX_API_KEY or raya-provider-keys.local.json.")

  const client = new MiniMaxTts()
  const chunks: Buffer[] = []
  const target = Number(process.env.VOICE_TTS_LATENCY_MS || 400)
  const result = await new Promise<TtsResult>((done, reject) => {
    client.speak(
      {
        id: "minimax-live",
        endpoint: "wss://api.minimax.io/ws/v1/t2a_v2",
        key,
        model: "speech-2.6-turbo",
        voice: process.env.MINIMAX_VOICE || "English_Graceful_Lady",
        text: process.env.VOICE_TEST_TEXT || "Raya is ready.",
      },
      {
        chunk: (data) => chunks.push(Buffer.from(data, "base64")),
        done,
        error: (error) => reject(new Error(error)),
      },
    )
  }).finally(() => client.dispose())

  if (result.chunks === 0 || result.bytes === 0) throw new Error("MiniMax returned no streaming audio.")
  if (result.firstAudioMs >= target)
    throw new Error(
      `MiniMax speech-2.6-turbo first-audio latency was ${result.firstAudioMs.toFixed(1)} ms (target <${target} ms).`,
    )
  if (Buffer.concat(chunks).byteLength !== result.bytes) throw new Error("MiniMax streamed byte count did not match.")
  console.log(
    JSON.stringify({
      provider: "MiniMax",
      model: "speech-2.6-turbo",
      firstAudioMs: Number(result.firstAudioMs.toFixed(1)),
      targetMs: target,
      chunks: result.chunks,
      bytes: result.bytes,
      passed: true,
    }),
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
