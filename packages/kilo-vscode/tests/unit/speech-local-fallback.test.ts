import { expect, spyOn, test } from "bun:test"
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
  await speech.realtimeStart(
    { requestId: "synthetic-local-request", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
    (message) => posts.push(message),
  )
  expect(posts).toEqual([
    {
      type: "speechRealtimeError",
      requestId: "synthetic-local-request",
      error: "Native realtime voice is disabled in Speech settings.",
      code: "configuration",
      fallback: "cascade-v1",
    },
  ])
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const load = speech.settings.load.bind(speech.settings)
  const probe = spyOn(speech.settings, "load").mockImplementation(async () => {
    const settings = await load()
    entered.resolve()
    await gate.promise
    return settings
  })
  const prior: unknown[] = []
  const latest: unknown[] = []
  try {
    const started = speech.realtimeStart(
      { requestId: "original-local", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
      (message) => prior.push(message),
    )
    await entered.promise
    const stopped = speech.realtimeStop("original-local", (message) => prior.push(message))
    const resumed = speech.realtimeStart(
      { requestId: "replacement-local", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
      (message) => latest.push(message),
    )
    expect(latest).toEqual([])
    const extra: unknown[] = []
    await speech.realtimeStart(
      { requestId: "unrelated-local", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
      (message) => extra.push(message),
    )
    expect(extra).toEqual([
      {
        type: "speechRealtimeError",
        requestId: "unrelated-local",
        code: "busy",
        error: "End the previous local voice session and wait for cleanup before restarting.",
      },
    ])
    await speech.realtimeStop("unrelated-local", (message) => extra.push(message))
    gate.resolve()
    await Promise.all([started, stopped, resumed])
    expect(prior).toEqual([{ type: "speechRealtimeStopped", requestId: "original-local" }])
    expect(latest).toEqual([
      {
        type: "speechRealtimeError",
        requestId: "replacement-local",
        code: "configuration",
        error: "Native realtime voice is disabled in Speech settings.",
        fallback: "cascade-v1",
      },
    ])
    expect(extra).toHaveLength(1)
  } finally {
    gate.resolve()
    probe.mockRestore()
  }
  const cancelled = Promise.withResolvers<void>()
  const observed = Promise.withResolvers<void>()
  const cancellation = spyOn(speech.settings, "load").mockImplementation(async () => {
    const settings = await load()
    observed.resolve()
    await cancelled.promise
    return settings
  })
  const retained: unknown[] = []
  const pending: unknown[] = []
  try {
    const original = speech.realtimeStart(
      { requestId: "cancel-original", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
      (message) => retained.push(message),
    )
    await observed.promise
    const stopped = speech.realtimeStop("cancel-original", (message) => retained.push(message))
    const waiting = speech.realtimeStart(
      { requestId: "cancel-waiting", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
      (message) => pending.push(message),
    )
    await speech.realtimeStop("cancel-waiting", (message) => pending.push(message))
    cancelled.resolve()
    await Promise.all([original, stopped, waiting])
    expect(retained).toEqual([{ type: "speechRealtimeStopped", requestId: "cancel-original" }])
    expect(pending).toEqual([{ type: "speechRealtimeStopped", requestId: "cancel-waiting" }])
  } finally {
    cancelled.resolve()
    cancellation.mockRestore()
  }
  const reads = spyOn(speech.settings, "load")
  const early: unknown[] = []
  const successor: unknown[] = []
  try {
    const started = speech.realtimeStart(
      { requestId: "before-broker", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
      (message) => early.push(message),
    )
    const stopped = speech.realtimeStop("before-broker", (message) => early.push(message))
    const restarted = speech.realtimeStart(
      { requestId: "after-broker", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
      (message) => successor.push(message),
    )
    await Promise.all([started, stopped, restarted])
    expect(early).toEqual([{ type: "speechRealtimeStopped", requestId: "before-broker" }])
    expect(successor).toEqual([
      {
        type: "speechRealtimeError",
        requestId: "after-broker",
        code: "configuration",
        error: "Native realtime voice is disabled in Speech settings.",
        fallback: "cascade-v1",
      },
    ])
    expect(reads).toHaveBeenCalledTimes(1)
  } finally {
    reads.mockRestore()
  }
  const current: unknown[] = []
  await speech.realtimeStart(
    { requestId: "current-local", sessionID: "synthetic-fallback", directory: import.meta.dir, connection },
    (message) => current.push(message),
  )
  expect(current).toEqual([
    {
      type: "speechRealtimeError",
      requestId: "current-local",
      code: "configuration",
      error: "Native realtime voice is disabled in Speech settings.",
      fallback: "cascade-v1",
    },
  ])
  await speech.realtimeStop("original-local", (message) => current.push(message))
  expect(current).toHaveLength(1)
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
  expect(stdout).toContain("Speech local fallback passed: 10 assertions")
}, 20000)
