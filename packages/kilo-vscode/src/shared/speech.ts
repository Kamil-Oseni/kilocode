// raya_change - Milestone H node-free speech contract shared with the webview
export type VoiceMode = "off" | "push-to-talk" | "hands-free"
export type VoiceEngine = "qwen-realtime" | "cascade-v1"

export type SpeechSettings = {
  voiceEngine: VoiceEngine
  realtimeEndpoint: string
  realtimeModel: string
  realtimeVoice: string
  mediaFrontendURL: string
  sttEndpoint: string
  sttModel: string
  ttsEndpoint: string
  ttsModel: string
  voice: string
  mode: VoiceMode
  autoSpeak: boolean
  cliMirror: boolean
  vadThreshold: number
  vadSilenceMs: number
}

export type SpeechState = SpeechSettings & {
  hasRealtimeKey: boolean
  hasSttKey: boolean
  hasTtsKey: boolean
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  voiceEngine: "qwen-realtime",
  realtimeEndpoint: "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime",
  realtimeModel: "qwen-audio-3.0-realtime-plus",
  realtimeVoice: "longanqian",
  mediaFrontendURL: "http://127.0.0.1:7890",
  sttEndpoint: "",
  sttModel: "SenseVoice-Small",
  ttsEndpoint: "wss://api.minimax.io/ws/v1/t2a_v2",
  ttsModel: "speech-2.6-turbo",
  voice: "English_Graceful_Lady",
  mode: "push-to-talk",
  autoSpeak: true,
  cliMirror: false,
  vadThreshold: 0.025,
  vadSilenceMs: 900,
}
