// raya_change - Milestone H config-swap and secret-storage evidence
import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SpeechSettingsStore } from "../../src/speech/settings"

describe("voice configuration", () => {
  it("swaps realtime, STT, and TTS models without code changes", async () => {
    const state = storage()
    const secrets = secret()
    const store = new SpeechSettingsStore(state, secrets)

    await store.update({
      realtimeModel: "qwen-audio-3.0-realtime-flash",
      realtimeVoice: "longanlingxi",
      sttModel: "paraformer-zh-streaming",
      ttsModel: "speech-2.8-hd",
      voice: "Chinese_Lyrical",
    })
    const settings = await store.load()

    expect(settings.realtimeModel).toBe("qwen-audio-3.0-realtime-flash")
    expect(settings.realtimeVoice).toBe("longanlingxi")
    expect(settings.sttModel).toBe("paraformer-zh-streaming")
    expect(settings.ttsModel).toBe("speech-2.8-hd")
    expect(settings.voice).toBe("Chinese_Lyrical")
  })

  it("keeps keys out of public settings and mirrors their separate roles only when enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-speech-"))
    const state = storage()
    const secrets = secret()
    const store = new SpeechSettingsStore(state, secrets)
    try {
      await store.setKey("stt", "stt-secret")
      await store.setKey("tts", "tts-secret")
      await store.setKey("realtime", "realtime-secret")
      const settings = await store.load()
      expect(settings.hasRealtimeKey).toBe(true)
      expect(settings.hasSttKey).toBe(true)
      expect(settings.hasTtsKey).toBe(true)
      expect(JSON.stringify(settings)).not.toContain("secret")

      await store.sync(root)
      expect(await Bun.file(join(root, ".raya/speech.local.json")).exists()).toBe(false)

      await store.update({ cliMirror: true })
      await store.sync(root)
      const mirror = await readFile(join(root, ".raya/speech.local.json"), "utf8")
      const ignore = await readFile(join(root, ".gitignore"), "utf8")
      expect(mirror).toContain("stt-secret")
      expect(mirror).toContain("tts-secret")
      expect(mirror).toContain("realtime-secret")
      expect(ignore).toContain(".raya/speech.local.json")
      await store.setKey("realtime", undefined)
      await store.sync(root)
      const separated = JSON.parse(await readFile(join(root, ".raya/speech.local.json"), "utf8"))
      expect(separated.realtime.key).toBeUndefined()
      expect(separated.stt.key).toBe("stt-secret")
      expect(separated.tts.key).toBe("tts-secret")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function storage() {
  const data = new Map<string, unknown>()
  return {
    get: <T>(key: string, fallback?: T) => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void data.set(key, value),
  }
}

function secret() {
  const data = new Map<string, string>()
  return {
    get: async (key: string) => data.get(key),
    store: async (key: string, value: string) => void data.set(key, value),
    delete: async (key: string) => void data.delete(key),
  }
}
