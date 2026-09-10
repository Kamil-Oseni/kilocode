// raya_change - Milestone H Speech panel for provider-pluggable voice configuration
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Select } from "@kilocode/kilo-ui/select"
import { createSignal, Show, type Component } from "solid-js"
import { useVoice } from "../../context/voice"
import { OPENAI_VOICE_MODEL, type VoiceEngine } from "../../../../src/shared/speech"
import SettingsRow from "./SettingsRow"

const ENGINES: Array<{ value: VoiceEngine; label: string }> = [
  { value: "openai-realtime", label: "OpenAI Realtime (preview)" },
  { value: "qwen-realtime", label: "Legacy Qwen Realtime (experimental)" },
  { value: "cascade-v1", label: "Configured STT → Raya → MiniMax (cascade-v1)" },
]

const SpeechTab: Component = () => {
  const voice = useVoice()
  const [key, setKey] = createSignal("")
  const [realtimeKey, setRealtimeKey] = createSignal("")
  const [sttKey, setSttKey] = createSignal("")
  const [ttsKey, setTtsKey] = createSignal("")
  const settings = voice.settings

  return (
    <div class="speech-settings" style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
      <p style={{ margin: 0, color: "var(--vscode-descriptionForeground)", "font-size": "var(--kilo-font-size-12)" }}>
        OpenAI is the default for new voice setups and connects directly over WebRTC when you start a call. Work stays
        in the current conversation. Ending voice releases audio; admitted work continues until you stop it in the
        conversation. Dictation remains a separate draft-entry action. OpenAI failures never silently switch to another
        provider.
      </p>
      <Card>
        <SettingsRow
          title="Voice engine"
          description="Saved provider choices are preserved. Changing this selection ends the current call; it does not start recording."
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
            triggerProps={{ "aria-label": "Voice engine" }}
          />
        </SettingsRow>
        <Show when={settings().voiceEngine === "openai-realtime"}>
          <SettingsRow
            title="OpenAI model"
            description="Native speech-to-speech voice with work handled by the current Raya conversation."
          >
            <span>{OPENAI_VOICE_MODEL}</span>
          </SettingsRow>
          <SettingsRow title="OpenAI voice" description="OpenAI voice name; the initial voice is marin.">
            <TextField
              aria-label="OpenAI voice"
              value={settings().openaiVoice}
              onChange={(openaiVoice) => voice.update({ openaiVoice })}
            />
          </SettingsRow>
          <SettingsRow
            title="OpenAI API key"
            description={
              settings().hasOpenAIKey
                ? "An OpenAI key is stored in VS Code Secret Storage. It is never copied to the CLI speech mirror."
                : "Add a key with access to the realtime model. Legacy voice and transcription keys are not reused."
            }
          >
            <div class="speech-key-fields">
              <TextField
                type="password"
                autocomplete="off"
                value={key()}
                onChange={setKey}
                placeholder="OpenAI API key"
                aria-label="OpenAI API key"
              />
              <Button
                size="small"
                aria-label="Save OpenAI API key"
                disabled={!key().trim()}
                onClick={() => {
                  voice.setKey("openai", key())
                  setKey("")
                }}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="small"
                aria-label="Clear OpenAI API key"
                onClick={() => voice.setKey("openai")}
              >
                Clear
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow
            title="Live voice status"
            description="Microphone, interruption and latency still require validation on your device. Live input captions use OpenAI transcription and may differ from what the audio model heard."
            last
          >
            <div class="speech-live-status">
              <span role="status">
                {voice.status()} ·{" "}
                {voice.aec() ? "Echo cancellation requested and enabled" : "Echo cancellation unverified"}
              </span>
              <Show when={voice.error()}>
                {(error) => (
                  <span class="speech-status-error" role="alert">
                    {error()}
                  </span>
                )}
              </Show>
            </div>
          </SettingsRow>
        </Show>
        <Show when={settings().voiceEngine === "qwen-realtime"}>
          <SettingsRow title="Qwen realtime endpoint" description="Qwen Audio Realtime WebSocket endpoint.">
            <TextField
              aria-label="Qwen realtime endpoint"
              value={settings().realtimeEndpoint}
              onChange={(realtimeEndpoint) => voice.update({ realtimeEndpoint })}
            />
          </SettingsRow>
          <SettingsRow title="Qwen realtime model" description="Swappable speech-to-speech model ID.">
            <TextField
              aria-label="Qwen realtime model"
              value={settings().realtimeModel}
              onChange={(realtimeModel) => voice.update({ realtimeModel })}
            />
          </SettingsRow>
          <SettingsRow title="Qwen realtime voice" description="Qwen system or cloned voice ID.">
            <TextField
              aria-label="Qwen realtime voice"
              value={settings().realtimeVoice}
              onChange={(realtimeVoice) => voice.update({ realtimeVoice })}
            />
          </SettingsRow>
          <SettingsRow
            title="Qwen realtime API key"
            description={
              settings().hasRealtimeKey
                ? "A separate realtime key is stored. Enter a replacement or clear it."
                : "Add a Qwen realtime key. Transcription and synthesis keys are kept separate."
            }
          >
            <div class="speech-key-fields">
              <TextField
                type="password"
                autocomplete="off"
                aria-label="Qwen realtime API key"
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
              aria-label="Media frontend"
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
        </Show>
      </Card>
      <Card>
        <SettingsRow
          title="STT endpoint"
          description="Full OpenAI-compatible audio/transcriptions or Qwen ASR chat/completions URL."
        >
          <TextField
            aria-label="STT endpoint"
            value={settings().sttEndpoint}
            placeholder="https://…/v1/audio/transcriptions"
            onChange={(sttEndpoint) => voice.update({ sttEndpoint })}
          />
        </SettingsRow>
        <SettingsRow title="STT model" description="SenseVoice, Paraformer, Nano, Qwen-ASR, or another endpoint model.">
          <TextField
            aria-label="STT model"
            value={settings().sttModel}
            onChange={(sttModel) => voice.update({ sttModel })}
          />
        </SettingsRow>
        <SettingsRow
          title="STT API key"
          description={
            settings().hasSttKey ? "A key is stored securely. Enter a replacement or clear it." : "No key stored."
          }
        >
          <div class="speech-key-fields">
            <TextField
              type="password"
              autocomplete="off"
              aria-label="STT API key"
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
        <Show when={settings().voiceEngine !== "openai-realtime"}>
          <SettingsRow
            title="Test voice output"
            description="Play a short phrase through the configured MiniMax stream."
          >
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
        </Show>
      </Card>
      <Card>
        <SettingsRow title="TTS WebSocket endpoint" description="MiniMax streaming T2A endpoint.">
          <TextField
            aria-label="TTS WebSocket endpoint"
            value={settings().ttsEndpoint}
            onChange={(ttsEndpoint) => voice.update({ ttsEndpoint })}
          />
        </SettingsRow>
        <SettingsRow
          title="TTS model"
          description="Use speech-2.6-turbo for interactive latency or an HD model for quality."
        >
          <TextField
            aria-label="TTS model"
            value={settings().ttsModel}
            onChange={(ttsModel) => voice.update({ ttsModel })}
          />
        </SettingsRow>
        <SettingsRow title="Voice ID" description="Any MiniMax system, generated, or cloned voice ID.">
          <TextField
            aria-label="Voice ID"
            value={settings().voice}
            onChange={(voiceID) => voice.update({ voice: voiceID })}
          />
        </SettingsRow>
        <SettingsRow
          title="MiniMax API key"
          description={
            settings().hasTtsKey ? "A key is stored securely. Enter a replacement or clear it." : "No key stored."
          }
        >
          <div class="speech-key-fields">
            <TextField
              type="password"
              autocomplete="off"
              aria-label="MiniMax API key"
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
            aria-label="Hands-free silence"
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
