import { expect, test } from "bun:test"
import { join } from "node:path"
import type * as vscode from "vscode"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"
import { voiceFallback } from "../../src/speech/fallback"
import { SpeechService } from "../../src/speech/service"

test("cascade requires the selected output credential", () => {
  const state = {
    ...DEFAULT_SPEECH_SETTINGS,
    sttEndpoint: "http://127.0.0.1:8770/v1/audio/transcriptions",
    hasSttKey: true,
    hasTtsKey: false,
    hasLocalKey: true,
  }
  expect(voiceFallback({ ...state, ttsEngine: "local-jobs" })).toBe("cascade-v1")
  expect(voiceFallback({ ...state, ttsEngine: "local-jobs", hasLocalKey: false, hasTtsKey: true })).toBe("text")
  expect(voiceFallback({ ...state, ttsEngine: "minimax" })).toBe("text")
  expect(voiceFallback({ ...state, ttsEngine: "minimax", hasTtsKey: true })).toBe("cascade-v1")
  expect(voiceFallback({ ...state, ttsEngine: undefined, hasTtsKey: true })).toBe("cascade-v1")
  expect(voiceFallback({ ...state, ttsEngine: undefined })).toBe("text")
  expect(voiceFallback({ ...state, ttsEngine: "local-jobs", hasSttKey: false })).toBe("text")
  expect(voiceFallback({ ...state, ttsEngine: "local-jobs", sttEndpoint: "" })).toBe("text")
})

test("the host selects local cascade before contacting realtime", async () => {
  const values = new Map<string, unknown>()
  const keys = new Map<string, string>()
  const context = {
    globalState: {
      get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        values.set(key, value)
      },
    },
    secrets: {
      get: async (key: string) => keys.get(key),
      store: async (key: string, value: string) => {
        keys.set(key, value)
      },
      delete: async (key: string) => {
        keys.delete(key)
      },
    },
  } as unknown as vscode.ExtensionContext
  const speech = new SpeechService(context)
  await speech.settings.update({
    voiceEngine: "cascade-v1",
    sttEngine: "local",
    ttsEngine: "local-jobs",
    sttEndpoint: "http://127.0.0.1:8770/v1/audio/transcriptions",
  })
  await speech.settings.setKey("local", "synthetic-speech-only-key-123456")
  const posts: unknown[] = []
  const connection = {
    getClientAsync: () => {
      throw new Error("Unexpected realtime request")
    },
  } as unknown as KiloConnectionService
  await speech.realtimeStart({ sessionID: "synthetic-fallback", directory: import.meta.dir, connection }, (message) =>
    posts.push(message),
  )
  expect(posts).toEqual([
    {
      type: "speechRealtimeError",
      error: "Native realtime voice is disabled in Speech settings.",
      code: "configuration",
      fallback: "cascade-v1",
    },
  ])
  speech.dispose()
  await speech.ended()
  expect(speech.admin()).toEqual({ available: false, active: 0, failed: 1, incomplete: 0 })
})

test("local cascade reaches the actual browser provider without a MiniMax key", async () => {
  const child = Bun.spawn(
    ["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/speech-local-fallback.mjs")],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const timer = setTimeout(() => child.kill(), 15000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain("Speech local fallback passed: 9 assertions")
}, 20000)
