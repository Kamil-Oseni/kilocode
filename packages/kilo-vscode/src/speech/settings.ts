// raya_change - Milestone H encrypted speech settings and optional CLI mirror
import { mkdir, readFile, unlink, writeFile, open, lstat, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import { local } from "./local"
import { dirname, join, resolve } from "node:path"
import type * as vscode from "vscode"
import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings, type SpeechState, type SpeechKey } from "../shared/speech" // raya_change - node-free webview contract
export { DEFAULT_SPEECH_SETTINGS, type SpeechSettings, type SpeechState, type VoiceMode } from "../shared/speech"

const STATE = "raya.speech.settings"
const REALTIME = "raya.speech.realtime.key"
const OPENAI = "raya.speech.openai.key"
const STT = "raya.speech.stt.key"
const TTS = "raya.speech.tts.key"
const LOCAL = "raya.speech.local.tts.key"
const TOKEN = "D:/Raya/Services/Speech/access-token.txt"
const MIRROR = ".raya/speech.local.json"

type Storage = Pick<vscode.Memento, "get" | "update">
type Secrets = Pick<vscode.SecretStorage, "get" | "store" | "delete">

export class SpeechSettingsStore {
  constructor(
    private readonly state: Storage,
    private readonly secrets: Secrets,
    private readonly importation: () => Promise<string> = () => credential(TOKEN),
  ) {}

  async load(): Promise<SpeechState> {
    const settings = normalize(this.state.get<Partial<SpeechSettings>>(STATE))
    const [realtime, stt, tts, openai, local] = await Promise.all([
      this.secrets.get(REALTIME),
      this.secrets.get(STT),
      this.secrets.get(TTS),
      this.secrets.get(OPENAI),
      this.secrets.get(LOCAL),
    ])
    return {
      ...settings,
      hasOpenAIKey: !!openai,
      hasRealtimeKey: !!realtime,
      hasSttKey: settings.sttEngine === "local" ? !!local : !!stt,
      hasTtsKey: !!tts,
      hasLocalKey: !!local,
    }
  }

  async update(settings: Partial<SpeechSettings>): Promise<SpeechState> {
    await this.state.update(STATE, normalize({ ...this.state.get<Partial<SpeechSettings>>(STATE), ...settings }))
    return this.load()
  }

  async setKey(kind: SpeechKey, key?: string): Promise<SpeechState> {
    const name =
      kind === "local"
        ? LOCAL
        : kind === "openai"
          ? OPENAI
          : kind === "realtime"
            ? REALTIME
            : kind === "stt"
              ? STT
              : TTS
    const value = key?.trim()
    if (value) await this.secrets.store(name, value)
    if (!value) await this.secrets.delete(name)
    return this.load()
  }

  async key(kind: SpeechKey) {
    if (kind === "local") return this.secrets.get(LOCAL)
    if (kind === "openai") return this.secrets.get(OPENAI)
    if (kind === "realtime") return this.secrets.get(REALTIME)
    return this.secrets.get(kind === "stt" ? STT : TTS)
  }

  async local(): Promise<SpeechState> {
    const token = await this.importation()
    await this.secrets.store(LOCAL, token)
    return this.update({
      voiceEngine: "cascade-v1",
      sttEndpoint: "http://127.0.0.1:8770/v1/audio/transcriptions",
      sttEngine: "local",
      sttModel: "whisper-small.en",
      ttsEngine: "local-jobs",
      localTtsEndpoint: "http://127.0.0.1:8770",
      localTtsModel: "chatterbox-nano",
      localTtsVoice: "freeman-reference-c-AI",
      localTtsFallback: false,
      mode: "push-to-talk",
      autoSpeak: false,
      cliMirror: false,
    })
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
    ...normalizeLocal(input),
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

function normalizeLocal(input?: Partial<SpeechSettings>) {
  return {
    sttEngine: input?.sttEngine === "local" ? ("local" as const) : ("http" as const),
    ttsEngine: input?.ttsEngine === "local-jobs" ? ("local-jobs" as const) : ("minimax" as const),
    localTtsEndpoint: local(input?.localTtsEndpoint ?? "") ?? DEFAULT_SPEECH_SETTINGS.localTtsEndpoint,
    localTtsModel: text(input?.localTtsModel, DEFAULT_SPEECH_SETTINGS.localTtsModel!),
    localTtsVoice: text(input?.localTtsVoice, DEFAULT_SPEECH_SETTINGS.localTtsVoice!),
    localTtsFallback: input?.localTtsFallback === true,
  }
}

/** Internal descriptor reader; the user-facing setup always supplies the fixed trusted service path. */
export async function credential(file: string): Promise<string> {
  const errors: unknown[] = []
  const result: { value?: string } = {}
  const handle = await (async () => {
    if ((await realpath(file)).toLowerCase() !== resolve(file).toLowerCase())
      throw new Error("Local speech credentials unavailable")
    const before = await lstat(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 4096n)
      throw new Error("Local speech credentials unavailable")
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat({ bigint: true })
      if (
        before.dev !== stat.dev ||
        before.ino !== stat.ino ||
        before.size !== stat.size ||
        !stat.isFile() ||
        stat.nlink !== 1n
      )
        throw new Error("Local speech credentials unavailable")
      return { handle, before }
    } catch (err) {
      await handle.close().catch((close) => {
        throw new AggregateError([err, close], "Local speech credentials unavailable")
      })
      throw err
    }
  })().catch(() => {
    throw new Error("Local speech credentials unavailable")
  })
  try {
    const bytes = await handle.handle.readFile()
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()
    if (!/^[A-Za-z0-9._~-]{16,4096}$/.test(text)) throw new Error("Local speech credentials unavailable")
    const after = await lstat(file, { bigint: true })
    const held = await handle.handle.stat({ bigint: true })
    for (const stat of [after, held])
      if (
        stat.dev !== handle.before.dev ||
        stat.ino !== handle.before.ino ||
        stat.size !== handle.before.size ||
        stat.mtimeNs !== handle.before.mtimeNs ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n
      )
        throw new Error("Local speech credentials unavailable")
    result.value = text
  } catch (err) {
    errors.push(err)
  }
  try {
    await handle.handle.close()
  } catch (err) {
    errors.push(err)
  }
  if (errors.length)
    throw new Error("Local speech credentials unavailable", {
      cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
    })
  return result.value!
}

// raya_change - keep native-engine validation separate from the legacy cascade normalization.
function normalizeRealtime(input?: Partial<SpeechSettings>) {
  return {
    voiceEngine:
      input?.voiceEngine === "openai-live" ||
      input?.voiceEngine === "openai-realtime" ||
      input?.voiceEngine === "cascade-v1" ||
      input?.voiceEngine === "qwen-realtime"
        ? input.voiceEngine
        : DEFAULT_SPEECH_SETTINGS.voiceEngine,
    openaiVoice: text(input?.openaiVoice, DEFAULT_SPEECH_SETTINGS.openaiVoice),
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
