import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import "../../webview-ui/src/styles/prompt-input.css"
import "../../webview-ui/src/styles/welcome.css"
import "../../webview-ui/preview/preview.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { StoryProviders, mockSessionValue } from "../../webview-ui/src/stories/StoryProviders"
import { ProviderContext, useProvider } from "../../webview-ui/src/context/provider"
import { isModelValid } from "../../webview-ui/src/context/provider-utils"
import { SessionContext } from "../../webview-ui/src/context/session"
import { ServerContext, useServer } from "../../webview-ui/src/context/server"
import { NativeProjection } from "../../webview-ui/src/context/native-projection"
import { OpenAIVoice } from "../../webview-ui/src/context/openai-voice"
import { LiveVoice } from "../../webview-ui/src/context/live-voice"
import { VoiceProvider } from "../../webview-ui/src/context/voice"
import { PromptInput } from "../../webview-ui/src/components/chat/PromptInput"
import { WelcomeEmptyState } from "../../webview-ui/src/components/chat/WelcomeEmptyState"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"

const messages = []
window.__composerMessages = messages
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (msg) => messages.push(msg),
})
if (new URLSearchParams(location.search).has("native")) {
  window.__configureVoice = () =>
    window.postMessage(
      {
        type: "speechSettingsLoaded",
        settings: {
          ...DEFAULT_SPEECH_SETTINGS,
          voiceEngine: "openai-realtime",
          hasOpenAIKey: true,
          hasRealtimeKey: false,
          hasSttKey: false,
          hasTtsKey: false,
        },
      },
      "*",
    )
  window.__voiceStarts = 0
  window.__voiceStopped = 0
  window.__voiceMicrophone = false
  window.__workStops = 0
  OpenAIVoice.prototype.start = async function (input, exchange) {
    window.__voiceStarts++
    window.__nativeTransport = this
    this.operation = {
      ...input,
      closed: false,
      answer: true,
      channel: { readyState: "open" },
      audio: { muted: false },
      cancellations: new Set(),
      images: new Set(),
      projection: new NativeProjection(),
    }
    const operation = this.operation
    window.__nativeEvent = (packet) => {
      if (this.current(operation)) this.receive(operation, JSON.stringify(packet))
    }
    this.sink.status("connecting")
    await exchange("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n")
    this.sink.status("listening")
  }
  OpenAIVoice.prototype.stop = async function () {
    window.__voiceStopped++
    if (this.operation) this.operation.closed = true
    if (window.__voiceHoldCleanup)
      await new Promise((resolve, reject) => {
        window.__releaseVoiceCleanup = resolve
        window.__failVoiceCleanup = reject
      })
    clearTimeout(this.operation?.interruption)
    this.operation = undefined
    window.__nativeEvent = () => {}
    this.sink.status("off")
  }
  OpenAIVoice.prototype.mute = function (value) {
    window.__voiceMicrophone = value
    return true
  }
  const interrupt = OpenAIVoice.prototype.interrupt
  OpenAIVoice.prototype.interrupt = function () {
    this.operation.output ??= "utterance"
    return interrupt.call(this)
  }
  OpenAIVoice.prototype.image = function () {
    return true
  }
}
if (new URLSearchParams(location.search).has("live")) {
  window.__configureVoice = () =>
    window.postMessage(
      {
        type: "speechSettingsLoaded",
        settings: {
          ...DEFAULT_SPEECH_SETTINGS,
          voiceEngine: "openai-live",
          hasOpenAIKey: true,
          hasRealtimeKey: false,
          hasSttKey: false,
          hasTtsKey: false,
        },
      },
      "*",
    )
  window.__voiceStarts = 0
  window.__voiceStopped = 0
  window.__voiceMicrophone = false
  window.__workStops = 0
  LiveVoice.prototype.start = async function (input, exchange) {
    window.__voiceStarts++
    window.__liveTransport = this
    this.operation = { id: input.requestID, closed: false, started: false, muted: false, audio: { muted: false } }
    this.sink.status("connecting")
    await exchange("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n")
  }
  LiveVoice.prototype.started = function (id) {
    if (!this.operation || this.operation.id !== id || this.operation.closed) return
    this.operation.started = true
    this.sink.status("listening")
  }
  LiveVoice.prototype.stop = async function () {
    window.__voiceStopped++
    if (this.operation) this.operation.closed = true
    if (window.__voiceHoldCleanup)
      await new Promise((resolve, reject) => {
        window.__releaseVoiceCleanup = resolve
        window.__failVoiceCleanup = reject
      })
    this.operation = undefined
    this.sink.status("off")
  }
  LiveVoice.prototype.finalized = function () {
    if (window.__releaseVoiceCleanup) window.__releaseVoiceCleanup()
  }
  LiveVoice.prototype.mute = function (value) {
    if (!this.operation || this.operation.closed) return false
    this.operation.muted = value
    window.__voiceMicrophone = value
    return true
  }
  LiveVoice.prototype.silence = function (value) {
    if (!this.operation || this.operation.closed) return false
    this.operation.audio.muted = value
    return true
  }
}
const theme = new URLSearchParams(location.search).get("theme") ?? "dark"
document.body.className =
  theme === "light" ? "vscode-light" : theme === "contrast" ? "vscode-high-contrast" : "vscode-dark"
document.documentElement.setAttribute("data-theme", "kilo-vscode")
document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark"
document.body.classList.add(theme === "light" ? "pv-theme--light" : "pv-theme--dark")
const colors =
  theme === "light"
    ? { background: "#f5f5f5", foreground: "#222222", weak: "#595959", focus: "#45557a" }
    : theme === "contrast"
      ? { background: "#000000", foreground: "#ffffff", weak: "#ffffff", focus: "#ffff00" }
      : { background: "#1c1c1c", foreground: "#f1f1f1", weak: "#b8b8b8", focus: "#9ab0d6" }
for (const [key, value] of Object.entries({
  "editor-background": colors.background,
  "sideBar-background": colors.background,
  foreground: colors.foreground,
  descriptionForeground: colors.weak,
  "input-background": colors.background,
  "input-foreground": colors.foreground,
  "input-placeholderForeground": colors.weak,
  "input-border": colors.weak,
  focusBorder: colors.focus,
  contrastBorder: theme === "contrast" ? colors.foreground : "transparent",
}))
  document.body.style.setProperty(`--vscode-${key}`, value)
document.body.style.background = colors.background
document.body.style.color = colors.foreground

function Fixture() {
  const server = useServer()
  const provider = useProvider()
  const [connected, setConnected] = createSignal(true)
  const [id, setID] = createSignal(new URLSearchParams(location.search).has("cloud") ? "cloud:fixture" : "first")
  const [continuation, setContinuation] = createSignal({
    id: "ticket",
    directory: "C:/projects/a-very-long-unbroken-workspace-directory-name-for-narrow-history-recovery/recovery",
    status: "preview",
  })
  const [agent, setAgent] = createSignal("auto")
  const [selected, setSelected] = createSignal({ providerID: "kilo", modelID: "anthropic/claude-sonnet-4-6" })
  const [variant, setVariant] = createSignal()
  const [sent, setSent] = createSignal([])
  const [busy, setBusy] = createSignal(false)
  const session = {
    ...mockSessionValue(),
    currentSessionID: id,
    cloudPreviewId: () => (id().startsWith("cloud:") ? "fixture" : null),
    cloudContinuation: continuation,
    sessions: () => [
      { id: "local-copy", title: "Local cloud copy", updatedAt: new Date().toISOString() },
      { id: "first", title: "First", updatedAt: new Date().toISOString() },
      { id: "second", title: "Second", updatedAt: new Date().toISOString() },
    ],
    agents: () => [
      { name: "auto", displayName: "Auto", mode: "primary" },
      { name: "plan", displayName: "Plan", mode: "primary" },
    ],
    selectedAgent: agent,
    selectAgent: setAgent,
    selected,
    selectModel: (providerID, modelID) => setSelected({ providerID, modelID }),
    variantList: () => ["low", "high"],
    currentVariant: variant,
    selectVariant: setVariant,
    hasModelOverride: () => false,
    status: () => (busy() ? "busy" : "idle"),
    abort: () => {
      window.__workStops = (window.__workStops ?? 0) + 1
      setBusy(false)
    },
    sendMessage: (...args) => {
      setSent((prior) => [...prior, { args, agent: agent(), variant: variant() }])
      if (id().startsWith("cloud:")) setContinuation((entry) => ({ ...entry, status: "pending" }))
    },
  }
  return (
    <ServerContext.Provider
      value={{ ...server, isConnected: connected, connectionState: () => (connected() ? "connected" : "disconnected") }}
    >
      <ProviderContext.Provider
        value={{
          ...provider,
          isModelValid: (selection) => isModelValid(provider.providers(), provider.connected(), selection),
        }}
      >
        <SessionContext.Provider value={session}>
          <VoiceProvider>
            <main style={{ padding: "12px", "max-width": "760px", margin: "auto" }}>
              <WelcomeEmptyState />
              <PromptInput boxId="fixture" />
              <div aria-label="Fixture controls">
                <button onClick={() => setConnected(!connected())}>Toggle connection</button>
                <button onClick={() => setID(id() === "first" ? "second" : "first")}>Switch session</button>
                <button onClick={() => setSelected({ providerID: "missing-provider", modelID: "missing-model" })}>
                  Unavailable model
                </button>
                <button onClick={() => setBusy(!busy())}>Toggle busy</button>
                <button onClick={() => setID("local-copy")}>Acknowledge local copy</button>
                <button
                  onClick={() =>
                    window.postMessage(
                      {
                        type: "sendMessageFailed",
                        error: "Send failed after import",
                        sessionID: "local-copy",
                        draftID: "local-copy",
                        text: sent()[0].args[0],
                        files: sent()[0].args[3],
                      },
                      "*",
                    )
                  }
                >
                  Fail local copy send
                </button>
                <button
                  onClick={() =>
                    setContinuation((entry) => ({
                      ...entry,
                      status: "uncertain",
                      error: "Import outcome unknown. Check Local history.",
                    }))
                  }
                >
                  Uncertain cloud import
                </button>
                <button
                  onClick={() =>
                    window.postMessage(
                      {
                        type: "speechSettingsLoaded",
                        settings: {
                          ...DEFAULT_SPEECH_SETTINGS,
                          voiceEngine: "openai-realtime",
                          hasOpenAIKey: false,
                          hasRealtimeKey: false,
                          hasSttKey: false,
                          hasTtsKey: false,
                        },
                      },
                      "*",
                    )
                  }
                >
                  Select OpenAI preview without key
                </button>
              </div>
              <output hidden data-sent>
                {JSON.stringify(sent())}
              </output>
            </main>
          </VoiceProvider>
        </SessionContext.Provider>
      </ProviderContext.Provider>
    </ServerContext.Provider>
  )
}
render(
  () => (
    <StoryProviders noPadding config={{}}>
      <Fixture />
    </StoryProviders>
  ),
  document.getElementById("root"),
)
