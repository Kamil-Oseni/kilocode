import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as vscode from "vscode"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { routeInputToolMessage } from "../../src/services/input-tools"
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

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "raya-live-route-"))
  const posts: Record<string, unknown>[] = []
  const speech = new SpeechService(memory())
  const connection = {
    async getClientAsync() {
      return {}
    },
    getServerConfig() {
      return undefined
    },
  } as unknown as KiloConnectionService
  const send = (message: Record<string, unknown>) =>
    routeInputToolMessage(message, {
      connection,
      dir: root,
      post: (msg) => posts.push(msg as Record<string, unknown>),
      speech,
      voiceScope: (sessionID) => (sessionID === "session_1" ? { directory: root, current: () => true } : undefined),
    })
  return { posts, speech, send, root }
}

test("Live start routes through input-tools only when the saved engine is openai-live", async () => {
  const { posts, speech, send, root } = await harness()
  expect(
    await send({ type: "speechOpenAIStart", requestId: "request_1", sessionID: "session_1", sdp, engine: "live" }),
  ).toBe(true)
  expect(posts).toEqual([
    {
      type: "speechOpenAIError",
      requestId: "request_1",
      error: "GPT-Live requires an OpenAI API key in Speech settings.",
    },
  ])
  await speech.update({ voiceEngine: "openai-realtime" }, root, () => {})
  posts.length = 0
  await send({ type: "speechOpenAIStart", requestId: "request_1", sessionID: "session_1", sdp, engine: "live" })
  expect(posts).toEqual([
    {
      type: "speechOpenAIError",
      requestId: "request_1",
      error: "GPT-Live voice is not selected in Speech settings.",
    },
  ])
  await speech.update({ voiceEngine: "openai-live" }, root, () => {})
  posts.length = 0
  await send({ type: "speechOpenAIStart", requestId: "request_1", sessionID: "session_1", sdp, engine: "live" })
  expect(posts).toEqual([
    {
      type: "speechOpenAIError",
      requestId: "request_1",
      error: "GPT-Live requires an OpenAI API key in Speech settings.",
    },
  ])
  await speech.key("openai", "sk-live-secret", root, () => {})
  posts.length = 0
  await send({ type: "speechOpenAIStart", requestId: "request_1", sessionID: "session_1", sdp, engine: "live" })
  expect(posts).toEqual([
    {
      type: "speechOpenAIError",
      requestId: "request_1",
      error: "The voice connection or workspace changed.",
    },
  ])
  posts.length = 0
  await send({ type: "speechOpenAIStart", requestId: "request_1", sessionID: "session_1", sdp })
  expect(posts).toEqual([
    {
      type: "speechOpenAIError",
      requestId: "request_1",
      error: "OpenAI voice is not selected in Speech settings.",
    },
  ])
  expect(JSON.stringify(posts)).not.toContain("sk-live-secret")
  speech.dispose()
})

test("untrusted Live payloads are rejected before a broker starts and never include credentials", async () => {
  const { posts, speech, send, root } = await harness()
  await speech.update({ voiceEngine: "openai-live" }, root, () => {})
  await speech.key("openai", "sk-live-secret", root, () => {})
  expect(
    await send({ type: "speechOpenAIStart", requestId: "request_1", sessionID: "missing", sdp, engine: "live" }),
  ).toBe(true)
  expect(posts[0]).toMatchObject({
    type: "speechOpenAIError",
    error: "The voice session's workspace is unavailable or ambiguous. Reopen the task before starting voice.",
  })
  posts.length = 0
  await send({
    type: "speechOpenAIStart",
    requestId: "request_1",
    sessionID: "session_1",
    sdp: "x".repeat(262_145),
    engine: "live",
  })
  expect(posts[0]).toMatchObject({ type: "speechOpenAIError", requestId: "request_1" })
  posts.length = 0
  await send({
    type: "speechOpenAIStart",
    requestId: "request_1",
    sessionID: "session_1",
    sdp: "not-sdp",
    engine: "LIVE",
  })
  expect(posts[0]).toMatchObject({
    type: "speechOpenAIError",
    error: "The voice connection request is invalid. End voice and try again.",
  })
  posts.length = 0
  await send({ type: "speechLiveControl", requestId: "request_1", eventID: "event_1", action: "pause" })
  expect(posts).toEqual([
    {
      type: "speechLiveControlResult",
      requestId: "request_1",
      eventID: "event_1",
      status: "failed",
      error: "Voice control was not understood. End voice and reconnect if needed.",
    },
  ])
  posts.length = 0
  await send({ type: "speechLiveControl", requestId: "request_1", eventID: "event_1", action: "mute" })
  expect(posts).toEqual([
    {
      type: "speechLiveControlResult",
      requestId: "request_1",
      eventID: "event_1",
      status: "failed",
      error: "Live voice is not ready in this task.",
    },
  ])
  posts.length = 0
  await send({ type: "speechOpenAIImage", requestId: "request_1", imageID: "img_1", data: "aaaa" })
  expect(posts[0]).toMatchObject({ type: "speechOpenAIImageResult", imageID: "img_1", status: "failed" })
  posts.length = 0
  await send({ type: "speechOpenAIStop", requestId: "request_other" })
  expect(posts).toEqual([{ type: "speechOpenAIStopped", requestId: "request_other" }])
  expect(JSON.stringify(posts)).not.toContain("sk-live-secret")
  expect(JSON.stringify(posts)).not.toContain("backend-password")
  speech.dispose()
})

test("openai-live CLI mirror does not write the OpenAI key and native Live skips cascade replies", async () => {
  const { posts, speech, send, root } = await harness()
  await speech.update({ voiceEngine: "openai-live", cliMirror: true, mode: "hands-free" }, root, () => {})
  await speech.key("openai", "sk-live-secret", root, () => {})
  await speech.key("stt", "stt-only", root, () => {})
  const mirrored = JSON.parse(await readFile(join(root, ".raya/speech.local.json"), "utf8"))
  expect(JSON.stringify(mirrored)).not.toContain("sk-live-secret")
  expect(mirrored.stt.key).toBe("stt-only")
  await send({ type: "speechVoiceTurn" })
  speech.trackMessage("session_1", "assistant", "msg_1")
  speech.trackPart("session_1", { id: "p1", messageID: "msg_1", type: "text", text: "hello" })
  await speech.speakOnIdle("session_1", (msg) => posts.push(msg as Record<string, unknown>))
  expect(posts).toEqual([])
  speech.dispose()
})

test("Live host microphone start and stop route through input-tools", async () => {
  const posts: Record<string, unknown>[] = []
  const seen = { start: "", stop: "" }
  const send = (message: Record<string, unknown>) =>
    routeInputToolMessage(message, {
      connection: {} as KiloConnectionService,
      dir: "/tmp",
      post: (msg) => posts.push(msg as Record<string, unknown>),
      speech: {
        liveMicStart: async (id, post) => {
          seen.start = id
          post({ type: "speechLiveMicReady", requestId: id })
        },
        liveMicStop: async (id) => {
          seen.stop = id
        },
      } as SpeechService,
    })
  expect(await send({ type: "speechLiveMicStart", requestId: "request_1" })).toBe(true)
  expect(seen.start).toBe("request_1")
  expect(posts).toEqual([{ type: "speechLiveMicReady", requestId: "request_1" }])
  expect(await send({ type: "speechLiveMicStop", requestId: "request_1" })).toBe(true)
  expect(seen.stop).toBe("request_1")
  posts.length = 0
  expect(await send({ type: "speechLiveMicStart", requestId: "" })).toBe(true)
  expect(seen.start).toBe("request_1")
  expect(posts).toEqual([])
})
