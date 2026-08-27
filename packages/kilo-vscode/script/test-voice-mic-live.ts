// raya_change - Milestone H physical-microphone accuracy evidence through configured speech settings
import { resolve } from "node:path"
import { characterErrorRate, wordErrorRate } from "../src/speech/accuracy"
import { transcribe } from "../src/speech/openai-stt"
import { cancelSpeechCapture, startSpeechCapture, stopSpeechCapture } from "../src/speech-to-text/capture"

type SpeechConfig = {
  stt?: { endpoint?: string; key?: string; model?: string }
}

const language =
  process.env.VOICE_TEST_LANGUAGE === "zh" ? "zh" : process.env.VOICE_TEST_LANGUAGE === "fr" ? "fr" : "en"
const expected =
  process.env.VOICE_TEST_EXPECTED ||
  (language === "zh"
    ? "今天天气很好，我们一起测试语音输入。"
    : language === "fr"
      ? "Raya transcrit correctement cette phrase en français."
      : "Raya accurately transcribes this English sentence.")
const duration = Number(process.env.VOICE_RECORD_MS || 6_000)
const requestId = crypto.randomUUID()

async function main() {
  process.env.KILO_FFMPEG_PATH ||= resolve(import.meta.dir, "../bin/ffmpeg.exe")
  const file = resolve(import.meta.dir, "../../../.raya/speech.local.json")
  if (!(await Bun.file(file).exists()))
    throw new Error("Enable CLI speech mirror in Raya Speech settings before running the physical microphone test.")
  const config = (await Bun.file(file).json()) as SpeechConfig
  if (!config.stt?.endpoint || !config.stt.key || !config.stt.model)
    throw new Error("The mirrored Speech settings do not contain a complete STT endpoint, model, and key.")

  console.log(`Recording starts in 2 seconds. Speak exactly: ${expected}`)
  await Bun.sleep(2_000)
  await startSpeechCapture({ requestId, model: config.stt.model, language })
  console.log(`Recording for ${(duration / 1_000).toFixed(1)} seconds...`)
  await Bun.sleep(duration)
  const audio = await stopSpeechCapture(requestId)
  const result = await transcribe({
    endpoint: config.stt.endpoint,
    key: config.stt.key,
    model: config.stt.model,
    data: audio.data,
    format: audio.format,
    language,
  })
  if (!result.ok) throw new Error(result.error)
  const error = language === "zh" ? characterErrorRate(expected, result.text) : wordErrorRate(expected, result.text)
  console.log(JSON.stringify({ language, expected, actual: result.text, error, passed: error <= 0.15 }))
  if (error > 0.15) throw new Error(`Physical microphone transcription error rate ${error.toFixed(3)} exceeded 0.15.`)
}

main().catch(async (err: unknown) => {
  await cancelSpeechCapture(requestId)
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
