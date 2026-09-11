// raya_change - Milestone H config-swap and secret-storage evidence
import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SpeechSettingsStore } from "../../src/speech/settings"

describe("voice configuration", () => {
  it("defaults absent and invalid engine values to OpenAI without inferring a provider from stored keys", async () => {
    for (const value of [undefined, {}, { voiceEngine: "unknown" }, { voiceEngine: null }, { mode: "off" }]) {
      const state = storage()
      if (value !== undefined) await state.update("raya.speech.settings", value)
      const store = new SpeechSettingsStore(state, secret())
      await store.setKey("realtime", "legacy-only")
      await store.setKey("stt", "dictation-only")
      const settings = await store.load()
      expect(settings.voiceEngine).toBe("openai-live")
      expect(settings.hasOpenAIKey).toBe(false)
      expect(await store.key("openai")).toBeUndefined()
      expect(settings.cliMirror).toBe(false)
      if (value?.mode === "off") expect(settings.mode).toBe("off")
      expect(state.get("raya.speech.settings")).toEqual(value)
    }
  })

  it("preserves every valid saved engine through unrelated edits and key changes", async () => {
    for (const engine of ["qwen-realtime", "cascade-v1", "openai-realtime", "openai-live"] as const) {
      const state = storage()
      await state.update("raya.speech.settings", { voiceEngine: engine, mode: "off", realtimeVoice: "saved-voice" })
      const store = new SpeechSettingsStore(state, secret())
      expect((await store.load()).voiceEngine).toBe(engine)
      await store.setKey("openai", "openai-only")
      await store.update({ vadSilenceMs: 1200 })
      expect(await store.load()).toMatchObject({
        voiceEngine: engine,
        mode: "off",
        realtimeVoice: "saved-voice",
        hasOpenAIKey: true,
      })
      await store.setKey("openai")
      expect((await store.load()).voiceEngine).toBe(engine)
    }
  })

  it("swaps realtime, STT, and TTS models without code changes", async () => {
    const state = storage()
    const secrets = secret()
    const store = new SpeechSettingsStore(state, secrets)

    await store.update({
      voiceEngine: "openai-realtime",
      openaiVoice: "marin",
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
    expect(settings.voiceEngine).toBe("openai-realtime")
    expect(settings.openaiVoice).toBe("marin")
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
      await store.setKey("openai", "openai-secret")
      const settings = await store.load()
      expect(settings.hasRealtimeKey).toBe(true)
      expect(settings.hasSttKey).toBe(true)
      expect(settings.hasTtsKey).toBe(true)
      expect(settings.hasOpenAIKey).toBe(true)
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
      expect(mirror).not.toContain("openai-secret")
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
