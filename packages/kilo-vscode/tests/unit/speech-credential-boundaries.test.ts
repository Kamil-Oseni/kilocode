import { expect, test } from "bun:test"
import { SpeechSettingsStore } from "../../src/speech/settings"

test("realtime admission never borrows a transcription or synthesis credential", async () => {
  const values = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const settings = new SpeechSettingsStore(
    {
      get<T>(key: string, fallback?: T) {
        return (values.get(key) ?? fallback) as T
      },
      async update(key, value) {
        values.set(key, value)
      },
    },
    {
      async get(key) {
        return secrets.get(key)
      },
      async store(key, value) {
        secrets.set(key, value)
      },
      async delete(key) {
        secrets.delete(key)
      },
    },
  )
  await settings.setKey("stt", "transcription-only")
  await settings.setKey("tts", "synthesis-only")
  expect(await settings.key("realtime")).toBeUndefined()
  expect(await settings.load()).toMatchObject({ hasRealtimeKey: false, hasSttKey: true, hasTtsKey: true })
  await settings.setKey("realtime", "realtime-only")
  expect(await settings.key("realtime")).toBe("realtime-only")
  expect(await settings.key("stt")).toBe("transcription-only")
  expect(await settings.key("tts")).toBe("synthesis-only")
  expect(await settings.load()).toMatchObject({ hasRealtimeKey: true, hasSttKey: true, hasTtsKey: true })
  await settings.setKey("realtime", undefined)
  expect(await settings.key("realtime")).toBeUndefined()
  expect(await settings.load()).toMatchObject({ hasRealtimeKey: false, hasSttKey: true, hasTtsKey: true })
})
