// raya_change - Milestone H Speech panel for provider-pluggable voice configuration
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Select } from "@kilocode/kilo-ui/select"
import { createSignal, Show, type Component } from "solid-js"
import { useVoice } from "../../context/voice"
import type { VoiceEngine } from "../../../../src/shared/speech"
import SettingsRow from "./SettingsRow"

const ENGINES: Array<{ value: VoiceEngine; label: string }> = [
  { value: "qwen-realtime", label: "Qwen Realtime (experimental)" },
  { value: "cascade-v1", label: "Configured STT → Raya → MiniMax (cascade-v1)" },
]

const SpeechTab: Component = () => {
  const voice = useVoice()
  const [realtimeKey, setRealtimeKey] = createSignal("")
  const [sttKey, setSttKey] = createSignal("")
  const [ttsKey, setTtsKey] = createSignal("")
  const settings = voice.settings

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
      <p style={{ margin: 0, color: "var(--vscode-descriptionForeground)", "font-size": "var(--kilo-font-size-12)" }}>
        Native hands-free voice uses LiveKit and Qwen Realtime. The configured STT and MiniMax stack is the first
        degradation rung; text remains the final rung. Keys use VS Code Secret Storage unless you enable the separate
        CLI speech mirror below.
      </p>
      <Card>
        <SettingsRow
          title="Voice engine"
          description="Choose Qwen's native realtime plane or cascade-v1 for your configured STT, Voice agent, and MiniMax."
        >
          <Select
            options={ENGINES}
            current={ENGINES.find((option) => option.value === settings().voiceEngine)}
            value={(option) => option.value}
            label={(option) => option.label}
            onSelect={(option) => option && voice.update({ voiceEngine: option.value })}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>
        <SettingsRow title="Qwen realtime endpoint" description="Qwen Audio Realtime WebSocket endpoint.">
          <TextField
            value={settings().realtimeEndpoint}
            onChange={(realtimeEndpoint) => voice.update({ realtimeEndpoint })}
          />
        </SettingsRow>
        <SettingsRow title="Qwen realtime model" description="Swappable speech-to-speech model ID.">
          <TextField value={settings().realtimeModel} onChange={(realtimeModel) => voice.update({ realtimeModel })} />
        </SettingsRow>
        <SettingsRow title="Qwen realtime voice" description="Qwen system or cloned voice ID.">
          <TextField value={settings().realtimeVoice} onChange={(realtimeVoice) => voice.update({ realtimeVoice })} />
        </SettingsRow>
        <SettingsRow
          title="Qwen realtime API key"
          description={
            settings().hasRealtimeKey
              ? "A separate realtime key is stored. Enter a replacement or clear it."
              : "Add a Qwen realtime key. Transcription and synthesis keys are kept separate."
          }
        >
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <TextField
              type="password"
              autocomplete="off"
              value={realtimeKey()}
              placeholder="Stored securely"
              onChange={setRealtimeKey}
            />
            <Button size="small" onClick={() => (voice.setKey("realtime", realtimeKey()), setRealtimeKey(""))}>
              Save
            </Button>
            <Button variant="ghost" size="small" onClick={() => voice.setKey("realtime")}>
              Clear
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow title="Media frontend" description="Local or deployed raya-mf control endpoint.">
          <TextField
            value={settings().mediaFrontendURL}
            onChange={(mediaFrontendURL) => voice.update({ mediaFrontendURL })}
          />
        </SettingsRow>
        <SettingsRow
          title="Realtime capability"
          description="Qwen passes streaming, semantic endpointing, interruption, and delegation. Measured-playout context truncation is unavailable."
          last
        >
          <span
            style={{
              color: "var(--vscode-errorForeground)",
              "font-size": "var(--kilo-font-size-12)",
              "text-align": "right",
            }}
          >
            Experimental · production truncation gate failed
            <br />
            {voice.status()} · {voice.aec() ? "AEC active" : "AEC unverified"}
          </span>
        </SettingsRow>
      </Card>
      <Card>
        <SettingsRow
          title="STT endpoint"
          description="Full OpenAI-compatible audio/transcriptions or Qwen ASR chat/completions URL."
        >
          <TextField
            value={settings().sttEndpoint}
            placeholder="https://…/v1/audio/transcriptions"
            onChange={(sttEndpoint) => voice.update({ sttEndpoint })}
          />
        </SettingsRow>
        <SettingsRow title="STT model" description="SenseVoice, Paraformer, Nano, Qwen-ASR, or another endpoint model.">
          <TextField value={settings().sttModel} onChange={(sttModel) => voice.update({ sttModel })} />
        </SettingsRow>
        <SettingsRow
          title="STT API key"
          description={
            settings().hasSttKey ? "A key is stored securely. Enter a replacement or clear it." : "No key stored."
          }
        >
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <TextField
              type="password"
              autocomplete="off"
              value={sttKey()}
              placeholder="Stored securely"
              onChange={setSttKey}
            />
            <Button size="small" onClick={() => (voice.setKey("stt", sttKey()), setSttKey(""))}>
              Save
            </Button>
            <Button variant="ghost" size="small" onClick={() => voice.setKey("stt")}>
              Clear
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow title="Test voice output" description="Play a short phrase through the configured MiniMax stream.">
          <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
            <Button size="small" disabled={!settings().hasTtsKey || voice.playing()} onClick={voice.test}>
              {voice.playing() ? "Playing…" : "Test voice"}
            </Button>
            <Show when={voice.error()}>
              {(error) => (
                <span style={{ color: "var(--vscode-errorForeground)", "font-size": "var(--kilo-font-size-12)" }}>
                  {error()}
                </span>
              )}
            </Show>
          </div>
        </SettingsRow>
      </Card>
      <Card>
        <SettingsRow title="TTS WebSocket endpoint" description="MiniMax streaming T2A endpoint.">
          <TextField value={settings().ttsEndpoint} onChange={(ttsEndpoint) => voice.update({ ttsEndpoint })} />
        </SettingsRow>
        <SettingsRow
          title="TTS model"
          description="Use speech-2.6-turbo for interactive latency or an HD model for quality."
        >
          <TextField value={settings().ttsModel} onChange={(ttsModel) => voice.update({ ttsModel })} />
        </SettingsRow>
        <SettingsRow title="Voice ID" description="Any MiniMax system, generated, or cloned voice ID.">
          <TextField value={settings().voice} onChange={(voiceID) => voice.update({ voice: voiceID })} />
        </SettingsRow>
        <SettingsRow
          title="MiniMax API key"
          description={
            settings().hasTtsKey ? "A key is stored securely. Enter a replacement or clear it." : "No key stored."
          }
        >
          <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
            <TextField
              type="password"
              autocomplete="off"
              value={ttsKey()}
              placeholder="Stored securely"
              onChange={setTtsKey}
            />
            <Button size="small" onClick={() => (voice.setKey("tts", ttsKey()), setTtsKey(""))}>
              Save
            </Button>
            <Button variant="ghost" size="small" onClick={() => voice.setKey("tts")}>
              Clear
            </Button>
          </div>
        </SettingsRow>
      </Card>
      <Card>
        <SettingsRow
          title="Speak agent responses"
          description="Stream completed responses through the selected TTS model."
        >
          <Switch checked={settings().autoSpeak} onChange={(autoSpeak) => voice.update({ autoSpeak })} hideLabel>
            Speak agent responses
          </Switch>
        </SettingsRow>
        <SettingsRow title="Hands-free silence" description="Milliseconds of silence that completes a spoken turn.">
          <TextField
            type="number"
            min="250"
            max="5000"
            value={String(settings().vadSilenceMs)}
            onChange={(value) => voice.update({ vadSilenceMs: Number(value) || 900 })}
          />
        </SettingsRow>
        <SettingsRow
          title="CLI speech mirror"
          description="Write a plaintext copy of speech credentials to .raya/speech.local.json for the CLI. Raya adds a .gitignore entry; this file is outside Secret Storage."
          last
        >
          <Switch checked={settings().cliMirror} onChange={(cliMirror) => voice.update({ cliMirror })} hideLabel>
            CLI speech mirror
          </Switch>
        </SettingsRow>
      </Card>
    </div>
  )
}

export default SpeechTab
