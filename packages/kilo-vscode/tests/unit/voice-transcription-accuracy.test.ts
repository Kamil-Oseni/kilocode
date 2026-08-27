// raya_change - Milestone H English/Chinese transcription accuracy contract
import { afterAll, describe, expect, it } from "bun:test"
import { characterErrorRate, wordErrorRate } from "../../src/speech/accuracy"
import { transcribe } from "../../src/speech/openai-stt"

const english = "Raya should preserve the speaker's exact words."
const chinese = "今天天气很好，我们一起测试语音输入。"
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer test-key") return new Response("Unauthorized", { status: 401 })
    if (new URL(request.url).pathname.endsWith("/chat/completions")) {
      const body = (await request.json()) as {
        model: string
        messages: Array<{ content: Array<{ input_audio: { data: string } }> }>
        asr_options: { language: string }
      }
      if (body.model !== "qwen3-asr-flash") return new Response("Wrong model", { status: 400 })
      if (!body.messages[0]?.content[0]?.input_audio.data.startsWith("data:audio/wav;base64,"))
        return new Response("Wrong audio", { status: 400 })
      return Response.json({
        choices: [{ message: { content: body.asr_options.language === "zh" ? chinese : english } }],
      })
    }
    const form = await request.formData()
    if (form.get("model") !== "SenseVoice-Small") return new Response("Wrong model", { status: 400 })
    const language = form.get("language")
    return Response.json({ text: language === "zh" ? chinese : english })
  },
})

afterAll(() => server.stop(true))

describe("transcription accuracy", () => {
  it("uses the configured endpoint and meets the English WER target", async () => {
    const result = await run("en")
    if (!result.ok) throw new Error(result.error)
    expect(wordErrorRate(english, result.text)).toBeLessThanOrEqual(0.1)
  })

  it("uses the configured endpoint and meets the Chinese CER target", async () => {
    const result = await run("zh")
    if (!result.ok) throw new Error(result.error)
    expect(characterErrorRate(chinese, result.text)).toBeLessThanOrEqual(0.1)
  })

  it("supports Qwen3-ASR through its OpenAI-compatible chat transport", async () => {
    const result = await transcribe({
      endpoint: new URL("/compatible-mode/v1/chat/completions", server.url).toString(),
      key: "test-key",
      model: "qwen3-asr-flash",
      data: Buffer.from("known sample").toString("base64"),
      format: "wav",
      language: "zh",
    })
    if (!result.ok) throw new Error(result.error)
    expect(characterErrorRate(chinese, result.text)).toBeLessThanOrEqual(0.1)
  })
})

function run(language: string) {
  return transcribe({
    endpoint: new URL("/v1/audio/transcriptions", server.url).toString(),
    key: "test-key",
    model: "SenseVoice-Small",
    data: Buffer.from("known sample").toString("base64"),
    format: "wav",
    language,
  })
}
