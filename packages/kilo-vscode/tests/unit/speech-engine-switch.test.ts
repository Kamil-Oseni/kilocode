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

test("a start and host microphone wait until the engine change is saved, then Live is refused", async () => {
  const hold = Promise.withResolvers<void>()
  const live = {
    active: true,
    owned(id: string) {
      return id === "request_1" && live.active
    },
    async stop() {
      await hold.promise
      live.active = false
    },
    async dispose() {
      return this.stop()
    },
  }
  const root = await mkdtemp(join(tmpdir(), "raya-voice-switch-race-"))
  const speech = new SpeechService(memory(), { live: live as unknown as LiveBroker })
  await speech.update({ voiceEngine: "openai-live" }, root, () => {})
  const posts: Record<string, unknown>[] = []
  const switching = speech.update({ voiceEngine: "openai-realtime" }, root, () => {})
  const mic = speech.liveMicStart("request_1", (msg) => posts.push(msg as Record<string, unknown>))
  const start = speech.openaiStart(
    {
      requestId: "request_2",
      engine: "live",
      sessionID: "session_1",
      sdp,
      directory: root,
      connection,
      current: () => true,
    },
    (msg) => posts.push(msg as Record<string, unknown>),
  )
  expect(live.active).toBe(true)
  expect((await speech.settings.load()).voiceEngine).toBe("openai-live")
  hold.resolve()
  await switching
  await mic
  await start
  expect(live.active).toBe(false)
  expect((await speech.settings.load()).voiceEngine).toBe("openai-realtime")
  expect(posts).toContainEqual({
    type: "speechLiveMicError",
    requestId: "request_1",
    error: "Live microphone capture is not available for this call.",
  })
  expect(posts).toContainEqual({
    type: "speechOpenAIError",
    requestId: "request_2",
    error: "GPT-Live voice is not selected in Speech settings.",
  })
  speech.dispose()
  await speech.ended()
})

test("backend drop releases Live and still admits a later start", async () => {
  const { live, speech, root } = await owned()
  expect(live.active).toBe(true)
  speech.drop()
  await speech.ended()
  expect(live.active).toBe(false)
  const posts: Record<string, unknown>[] = []
  await speech.openaiStart(
    {
      requestId: "request_2",
      engine: "live",
      sessionID: "session_1",
      sdp,
      directory: root,
      connection,
      current: () => true,
    },
    (msg) => posts.push(msg as Record<string, unknown>),
  )
  expect(posts).toEqual([
    {
      type: "speechOpenAIError",
      requestId: "request_2",
      error: "GPT-Live requires an OpenAI API key in Speech settings.",
    },
  ])
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
