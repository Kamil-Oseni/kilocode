import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as vscode from "vscode"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { LiveBroker } from "../../src/speech/live-broker"
import { SpeechService } from "../../src/speech/service"

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"

function memory() {
  const values = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  return {
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
  } as vscode.ExtensionContext
}

function park(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    if (signal.aborted) fail()
    signal.addEventListener("abort", fail, { once: true })
  })
}

const connection = {
  async getClientAsync() {
    return {}
  },
  getServerConfig() {
    return undefined
  },
} as unknown as KiloConnectionService

async function owned() {
  const live = new LiveBroker()
  const errors: string[] = []
  void live.start(
    { requestID: "request_1", sessionID: "session_1", sdp },
    (signal) => park(signal),
    () => {},
    (error) => errors.push(error),
  )
  const root = await mkdtemp(join(tmpdir(), "raya-voice-switch-"))
  const speech = new SpeechService(memory(), { live })
  await speech.update({ voiceEngine: "openai-live" }, root, () => {})
  return { live, speech, root, errors }
}

test("an engine change waits until the Live call is released before the new engine is saved", async () => {
  const { live, speech, root } = await owned()
  expect(live.active).toBe(true)
  const posts: unknown[] = []
  await speech.openaiStart(
    {
      requestId: "request_2",
      sessionID: "session_1",
      sdp,
      directory: root,
      connection,
      current: () => true,
    },
    (msg) => posts.push(msg),
  )
  expect(posts).toEqual([
    {
      type: "speechOpenAIError",
      requestId: "request_2",
      error: "End the existing voice call before switching to OpenAI.",
    },
  ])
  expect(live.active).toBe(true)
  await speech.update({ voiceEngine: "openai-realtime" }, root, () => {})
  expect(live.active).toBe(false)
  expect((await speech.settings.load()).voiceEngine).toBe("openai-realtime")
  speech.dispose()
  await speech.ended()
})

test("a mismatched stop leaves the Live call, and host disposal refuses later starts", async () => {
  const { live, speech, root } = await owned()
  const posts: Record<string, unknown>[] = []
  await speech.openaiStop("request_other", (msg) => posts.push(msg as Record<string, unknown>))
  expect(posts).toEqual([{ type: "speechOpenAIStopped", requestId: "request_other" }])
  expect(live.active).toBe(true)
  posts.length = 0
  await speech.openaiStop("request_1", (msg) => posts.push(msg as Record<string, unknown>))
  expect(posts).toEqual([{ type: "speechOpenAIStopped", requestId: "request_1" }])
  expect(live.active).toBe(false)
  await speech.update({ voiceEngine: "openai-live" }, root, () => {})
  await speech.key("openai", "sk-live-secret", root, () => {})
  speech.dispose()
  await speech.ended()
  posts.length = 0
  await speech.openaiStart(
    {
      requestId: "request_3",
      engine: "live",
      sessionID: "session_1",
      sdp,
      directory: root,
      connection,
      current: () => true,
    },
    (msg) => posts.push(msg as Record<string, unknown>),
  )
  expect(posts).toEqual([{ type: "speechOpenAIError", requestId: "request_3", error: "Voice is closed." }])
})
