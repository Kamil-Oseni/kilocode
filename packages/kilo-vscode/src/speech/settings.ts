// raya_change - Milestone H encrypted speech settings and optional CLI mirror
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type * as vscode from "vscode"
import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings, type SpeechState } from "../shared/speech" // raya_change - node-free webview contract
export { DEFAULT_SPEECH_SETTINGS, type SpeechSettings, type SpeechState, type VoiceMode } from "../shared/speech"

const STATE = "raya.speech.settings"
const REALTIME = "raya.speech.realtime.key"
const STT = "raya.speech.stt.key"
const TTS = "raya.speech.tts.key"
const MIRROR = ".raya/speech.local.json"

type Storage = Pick<vscode.Memento, "get" | "update">
type Secrets = Pick<vscode.SecretStorage, "get" | "store" | "delete">

export class SpeechSettingsStore {
  constructor(
    private readonly state: Storage,
    private readonly secrets: Secrets,
  ) {}

  async load(): Promise<SpeechState> {
    const settings = normalize(this.state.get<Partial<SpeechSettings>>(STATE))
    const [realtime, stt, tts] = await Promise.all([
      this.secrets.get(REALTIME),
      this.secrets.get(STT),
      this.secrets.get(TTS),
    ])
    return { ...settings, hasRealtimeKey: !!realtime, hasSttKey: !!stt, hasTtsKey: !!tts }
  }

  async update(settings: Partial<SpeechSettings>): Promise<SpeechState> {
    await this.state.update(STATE, normalize({ ...this.state.get<Partial<SpeechSettings>>(STATE), ...settings }))
    return this.load()
  }

  async setKey(kind: "realtime" | "stt" | "tts", key?: string): Promise<SpeechState> {
    const name = kind === "realtime" ? REALTIME : kind === "stt" ? STT : TTS
    const value = key?.trim()
    if (value) await this.secrets.store(name, value)
    if (!value) await this.secrets.delete(name)
    return this.load()
  }

  async key(kind: "realtime" | "stt" | "tts") {
    if (kind === "realtime") return this.secrets.get(REALTIME)
    return this.secrets.get(kind === "stt" ? STT : TTS)
  }

  async sync(root: string): Promise<void> {
    const settings = await this.load()
    const file = join(root, MIRROR)
    if (!settings.cliMirror) {
      await unlink(file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err
      })
      return
    }
    const [realtimeKey, sttKey, ttsKey] = await Promise.all([this.key("realtime"), this.key("stt"), this.key("tts")])
    await mkdir(dirname(file), { recursive: true })
    await ensureIgnored(root)
    await writeFile(
      file,
      JSON.stringify(
        {
          // This file is intentionally local and gitignored. It exists only for CLI speech clients.
          realtime: {
            endpoint: settings.realtimeEndpoint,
            model: settings.realtimeModel,
            voice: settings.realtimeVoice,
            key: realtimeKey,
          },
          stt: { endpoint: settings.sttEndpoint, model: settings.sttModel, key: sttKey },
          tts: { endpoint: settings.ttsEndpoint, model: settings.ttsModel, voice: settings.voice, key: ttsKey },
        },
        null,
        2,
      ),
      "utf8",
    )
  }
}

function normalize(input?: Partial<SpeechSettings>): SpeechSettings {
  const mode =
    input?.mode === "off" || input?.mode === "push-to-talk" || input?.mode === "hands-free"
      ? input.mode
      : DEFAULT_SPEECH_SETTINGS.mode
  return {
    ...normalizeRealtime(input),
    sttEndpoint: text(input?.sttEndpoint, DEFAULT_SPEECH_SETTINGS.sttEndpoint),
    sttModel: text(input?.sttModel, DEFAULT_SPEECH_SETTINGS.sttModel),
    ttsEndpoint: text(input?.ttsEndpoint, DEFAULT_SPEECH_SETTINGS.ttsEndpoint),
    ttsModel: text(input?.ttsModel, DEFAULT_SPEECH_SETTINGS.ttsModel),
    voice: text(input?.voice, DEFAULT_SPEECH_SETTINGS.voice),
    mode,
    autoSpeak: input?.autoSpeak ?? DEFAULT_SPEECH_SETTINGS.autoSpeak,
    cliMirror: input?.cliMirror ?? DEFAULT_SPEECH_SETTINGS.cliMirror,
    vadThreshold: bounded(input?.vadThreshold, 0.005, 0.25, DEFAULT_SPEECH_SETTINGS.vadThreshold),
    vadSilenceMs: bounded(input?.vadSilenceMs, 250, 5_000, DEFAULT_SPEECH_SETTINGS.vadSilenceMs),
  }
}

// raya_change - keep native-engine validation separate from the legacy cascade normalization.
function normalizeRealtime(input?: Partial<SpeechSettings>) {
  return {
    voiceEngine: input?.voiceEngine === "cascade-v1" ? ("cascade-v1" as const) : ("qwen-realtime" as const),
    realtimeEndpoint: text(input?.realtimeEndpoint, DEFAULT_SPEECH_SETTINGS.realtimeEndpoint),
    realtimeModel: text(input?.realtimeModel, DEFAULT_SPEECH_SETTINGS.realtimeModel),
    realtimeVoice: text(input?.realtimeVoice, DEFAULT_SPEECH_SETTINGS.realtimeVoice),
    mediaFrontendURL: text(input?.mediaFrontendURL, DEFAULT_SPEECH_SETTINGS.mediaFrontendURL),
  }
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" ? value.trim() : fallback
}

function bounded(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

async function ensureIgnored(root: string) {
  const file = join(root, ".gitignore")
  const current = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return ""
    throw err
  })
  const entry = ".raya/speech.local.json"
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return
  const prefix = current && !current.endsWith("\n") ? "\n" : ""
  await writeFile(file, `${current}${prefix}\n# raya_change - local CLI speech credentials\n${entry}\n`, "utf8")
}
