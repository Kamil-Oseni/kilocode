import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm, link } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { credential, SpeechSettingsStore } from "../../src/speech/settings"

test("local setup imports only the service key and keeps MiniMax", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-local-speech-settings-"))
  const file = join(root, "token")
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
    () => credential(file),
  )
  try {
    await writeFile(file, "synthetic-local-speech-key-123456\r\n")
    await settings.setKey("tts", "original-minimax")
    await settings.setKey("stt", "original-cloud-stt")
    expect(await settings.load()).toMatchObject({ ttsEngine: "minimax", localTtsFallback: false })
    const state = await settings.local()
    expect(state).toMatchObject({
      ttsEngine: "local-jobs",
      localTtsModel: "chatterbox-nano",
      localTtsVoice: "freeman-reference-c-AI",
      sttModel: "whisper-small.en",
      hasLocalKey: true,
      hasTtsKey: true,
      mode: "push-to-talk",
      autoSpeak: false,
      cliMirror: false,
      localTtsFallback: false,
    })
    expect(await settings.key("tts")).toBe("original-minimax")
    expect(await settings.key("local")).toBe("synthetic-local-speech-key-123456")
    expect(await settings.key("stt")).toBe("original-cloud-stt")
    expect(JSON.stringify(state)).not.toContain("synthetic-local")
    expect(JSON.stringify([...values.values()])).not.toContain("synthetic-local")
    await settings.sync(root)
    expect(await Bun.file(join(root, ".raya/speech.local.json")).exists()).toBe(false)
    await settings.update({ localTtsEndpoint: "https://example.com", localTtsFallback: true })
    expect(await settings.load()).toMatchObject({ localTtsEndpoint: "http://127.0.0.1:8770", localTtsFallback: true })
    await settings.setKey("local")
    expect(await settings.load()).toMatchObject({ hasLocalKey: false, hasTtsKey: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("credential descriptors reject invalid bytes and multiply linked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-local-speech-descriptor-"))
  const file = join(root, "token")
  try {
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x61]))
    await expect(credential(file)).rejects.toThrow("Local speech credentials unavailable")
    await writeFile(file, "x".repeat(4097))
    await expect(credential(file)).rejects.toThrow("Local speech credentials unavailable")
    await writeFile(file, "synthetic-key-123456789")
    await link(file, join(root, "other"))
    await expect(credential(file)).rejects.toThrow("Local speech credentials unavailable")
    await expect(credential(root)).rejects.toThrow("Local speech credentials unavailable")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed local setup does not replace cloud transcription credentials", async () => {
  const values = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const state = { failing: false }
  const store = new SpeechSettingsStore(
    {
      get<T>(key: string, fallback?: T) {
        return (values.get(key) ?? fallback) as T
      },
      async update(key, value) {
        if (state.failing) throw new Error("fixture state refused")
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
    async () => "synthetic-local-key-123456789",
  )
  await store.setKey("stt", "original-cloud-key")
  await store.update({ sttEngine: "http", sttEndpoint: "https://example.com/transcribe" })
  state.failing = true
  await expect(store.local()).rejects.toThrow("fixture state refused")
  expect(await store.load()).toMatchObject({ sttEngine: "http", sttEndpoint: "https://example.com/transcribe" })
  expect(await store.key("stt")).toBe("original-cloud-key")
})

test("actual local settings UI preserves explicit routing without audio", async () => {
  const child = Bun.spawn(
    ["bun", "--conditions=browser", join(import.meta.dir, "../fixtures/speech-local-settings.mjs")],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const timer = setTimeout(() => child.kill(), 25000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  expect(code, stdout + stderr).toBe(0)
  expect(stdout).toContain("Speech local settings integration passed: 24 assertions")
}, 30000)
