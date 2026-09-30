import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import "../../webview-ui/src/styles/prompt-input.css"
import "../../webview-ui/src/styles/welcome.css"
import "../../webview-ui/preview/preview.css"
import { createSignal, onMount } from "solid-js"
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
import { SidebarEmptyState } from "../../webview-ui/src/components/chat/SidebarEmptyState"
import { WorkStyleProvider } from "../../webview-ui/src/context/work-style"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"
import { useVSCode } from "../../webview-ui/src/context/vscode"
import { durableDrafts } from "../../webview-ui/src/utils/durable-drafts"

const messages = []
const profile = new URLSearchParams(location.search).get("draft") ?? crypto.randomUUID()
let held
window.__releaseDraftOwner = () => {
  if (held) {
    window.postMessage(held, "*")
    held = undefined
  }
}
window.__draftProfile = profile
const relay = async (message) => {
  const response = await fetch("http://127.0.0.1:5202", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, message }),
  })
  if (!response.ok) throw new Error("Draft fixture transport failed")
  return response.json()
}
window.__readDraft = (identity) =>
  relay({
    type: "composerDraftLoad",
    owner: profile,
    identity,
    requestID: crypto.randomUUID(),
    epoch: "fixture-read",
    generation: 1,
  })
window.__listDrafts = () =>
  relay({
    type: "composerDraftList",
    owner: profile,
    box: "fixture",
    requestID: crypto.randomUUID(),
    epoch: "fixture-list",
    generation: 1,
  })
window.__changeRemoteDraft = async (identity, text) => {
  const release = await window.__settleDraft(identity)
  try {
    const loaded = await window.__readDraft(identity)
    return await relay({
      type: "composerDraftSave",
      owner: profile,
      identity,
      expected: loaded.entry.token,
      content: { ...loaded.entry.content, text, selection: { start: text.length, end: text.length } },
      mutation: crypto.randomUUID(),
      requestID: crypto.randomUUID(),
      epoch: "fixture-write",
      generation: 1,
    })
  } finally {
    release()
  }
}
window.__composerMessages = messages
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (msg) => {
    messages.push(msg)
    if (msg.type === "composerDraftPane") {
      if (msg.active)
        queueMicrotask(() => {
          const state = {
            type: "composerDraftState",
            epoch: msg.epoch,
            generation: 1,
            owners: [{ box: "fixture", owner: profile }],
            connected: true,
          }
          if (new URLSearchParams(location.search).has("cold")) held = state
          else window.postMessage(state, "*")
        })
      return
    }
    if (
      [
        "composerDraftList",
        "composerDraftLoad",
        "composerDraftSave",
        "composerDraftClear",
        "composerDraftPromote",
      ].includes(msg.type)
    )
      void relay(msg).then((result) => window.postMessage(result, "*"))
  },
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
    this.operation = {
      id: input.requestID,
      closed: false,
      started: false,
      capture: false,
      muted: false,
      audio: { muted: false },
    }
    this.sink.status("connecting")
    await this.acquire()
    await exchange("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n")
  }
  LiveVoice.prototype.started = function (id) {
    if (!this.operation || this.operation.id !== id || this.operation.closed) return
    this.operation.started = true
    if (this.operation.capture) this.sink.status("listening")
  }
  LiveVoice.prototype.microphone = function (id) {
    if (!this.operation || this.operation.id !== id || this.operation.closed) return
    this.operation.capture = true
    if (this.operation.started) this.sink.status("listening")
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
  const durable = durableDrafts(useVSCode())
  window.__settleDraft = async (identity) => {
    const capture = await durable.capture(identity)
    if (!capture) throw new Error("Fixture draft did not settle")
    return () => durable.release(capture)
  }
  const server = useServer()
  const [workspace, setWorkspace] = createSignal("fixture-A")
  window.__switchDraftWorkspace = setWorkspace
  const provider = useProvider()
  const [connected, setConnected] = createSignal(true)
  const [id, setID] = createSignal(
    new URLSearchParams(location.search).has("pending")
      ? ""
      : new URLSearchParams(location.search).has("cloud")
        ? "cloud:fixture"
        : "first",
  )
  const [pending, setPending] = createSignal(new URLSearchParams(location.search).get("pending") ?? undefined)
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
  const accept = (capture) => {
    if (capture) {
      const requestID = crypto.randomUUID()
      void relay({
        type: "composerDraftClear",
        owner: capture.owner,
        requestID,
        epoch: capture.epoch,
        generation: capture.generation,
        identity: capture.identity,
        expected: capture.token,
        mutation: `accepted:${requestID}`,
      }).then((result) => {
        const accepted = {
          type: "composerDraftAccepted",
          epoch: capture.epoch,
          generation: capture.generation,
          sessionID: id(),
          messageID: requestID,
          capture,
          entry: result.entry,
          error: result.error,
        }
        if (window.__holdDraftAcceptance) {
          window.__acceptDraft = () => window.postMessage(accepted, "*")
          return
        }
        window.postMessage(accepted, "*")
      })
    }
  }
  const session = {
    ...mockSessionValue(),
    currentSessionID: () => id() || undefined,
    clearCurrentSession: () => setID(""),
    draftSessionID: pending,
    setDraftSessionID: (value) => {
      window.__pendingDraft = value
      setPending(value)
    },
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
    draftVariant: variant,
    selectVariant: setVariant,
    setSessionAgent: (_, value) => setAgent(value),
    setSessionModel: (_, providerID, modelID) => setSelected({ providerID, modelID }),
    setSessionVariant: (_, providerID, modelID, value) => {
      setSelected({ providerID, modelID })
      setVariant(value || undefined)
    },
    hasModelOverride: () => false,
    status: () => (busy() ? "busy" : "idle"),
    abort: () => {
      window.__workStops = (window.__workStops ?? 0) + 1
      setBusy(false)
    },
    sendCommand: (...args) => {
      setSent((prior) => [...prior, { args, agent: agent(), variant: variant() }])
      accept(args[9])
    },
    sendMessage: (...args) => {
      setSent((prior) => [...prior, { args, agent: agent(), variant: variant() }])
      if (id().startsWith("cloud:")) setContinuation((entry) => ({ ...entry, status: "pending" }))
      accept(args[8])
    },
  }
  return (
    <ServerContext.Provider
      value={{
        ...server,
        workspaceDirectory: workspace,
        isConnected: connected,
        connectionState: () => (connected() ? "connected" : "disconnected"),
      }}
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

function Onboarding() {
  onMount(() => {
    queueMicrotask(() => window.postMessage({ type: "workStyleLoaded", style: "unset" }, "*"))
  })
  return (
    <WorkStyleProvider>
      <main style={{ height: "100vh", overflow: "auto" }}>
        <SidebarEmptyState />
      </main>
    </WorkStyleProvider>
  )
}

const onboarding = new URLSearchParams(location.search).has("onboarding")
render(
  () => (
    <StoryProviders noPadding config={{}}>
      {onboarding ? <Onboarding /> : <Fixture />}
    </StoryProviders>
  ),
  document.getElementById("root"),
)
