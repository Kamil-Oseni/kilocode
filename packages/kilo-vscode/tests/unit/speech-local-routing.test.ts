import { expect, test } from "bun:test"
import type * as vscode from "vscode"
import { SpeechService } from "../../src/speech/service"

test("host local STT uses its configured private loopback port and refuses other targets", async () => {
  const values = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const context = {
    globalState: {
      get<T>(key: string, fallback?: T) {
        return (values.get(key) ?? fallback) as T
      },
      async update(key: string, value: unknown) {
        values.set(key, value)
      },
    },
    secrets: {
      async get(key: string) {
        return secrets.get(key)
      },
      async store(key: string, value: string) {
        secrets.set(key, value)
      },
      async delete(key: string) {
        secrets.delete(key)
      },
    },
  } as unknown as vscode.ExtensionContext
  const speech = new SpeechService(context)
  const posts: unknown[] = []
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push(request.url)
      expect(request.headers.get("Authorization")).toBe("Bearer private-routing-key")
      expect(new URL(request.url).pathname).toBe("/v1/audio/transcriptions")
      const form = await request.formData()
      expect(form.get("model")).toBe("whisper-small.en")
      expect(form.get("file")).toBeInstanceOf(Blob)
      return Response.json({ text: "Private service reached." })
    },
  })
  const input = { requestId: "private_stt", data: "AA==", format: "audio/wav" }
  try {
    await speech.settings.setKey("local", "private-routing-key")
    await speech.settings.update({
      sttEngine: "local",
      sttModel: "whisper-small.en",
      sttEndpoint: `${server.url}v1/audio/transcriptions`,
    })
    expect(await speech.configured()).toBe(true)
    await speech.transcribe(input, (msg) => posts.push(msg))
    expect(posts).toEqual([{ type: "speechToTextResult", requestId: "private_stt", text: "Private service reached." }])
    expect(calls).toEqual([`${server.url}v1/audio/transcriptions`])
    for (const target of [
      `${server.url}v1/audio/transcriptions?other=1`,
      `${server.url}v1/audio/transcriptions#other`,
      `${server.url}wrong`,
      `http://user:password@127.0.0.1:${server.port}/v1/audio/transcriptions`,
      `http://localhost:${server.port}/v1/audio/transcriptions`,
      "https://127.0.0.1/v1/audio/transcriptions",
      "http://192.168.100.160/v1/audio/transcriptions",
      "invalid",
    ]) {
      await speech.settings.update({ sttEndpoint: target })
      expect(await speech.configured()).toBe(false)
      posts.length = 0
      await speech.transcribe(input, (msg) => posts.push(msg))
      expect(posts).toEqual([
        {
          type: "speechToTextError",
          requestId: "private_stt",
          error: "Local transcription requires the configured loopback service.",
        },
      ])
      expect(calls).toHaveLength(1)
    }
    await speech.settings.update({ sttEndpoint: `${server.url}v1/audio/transcriptions` })
    await speech.settings.setKey("local")
    expect(await speech.configured()).toBe(false)
    await speech.transcribe(input, (msg) => posts.push(msg))
    expect(calls).toHaveLength(1)
  } finally {
    speech.dispose()
    await speech.ended()
    await server.stop(true)
  }
})
