import "@kilocode/kilo-ui/styles"
import { createSignal, onMount, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { SessionProvider, useSession } from "../../webview-ui/src/context/session"
import { VoiceProvider, useVoice } from "../../webview-ui/src/context/voice"
import { PromptInput } from "../../webview-ui/src/components/chat/PromptInput"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"
import { useVSCode } from "../../webview-ui/src/context/vscode"
import { dispatch } from "../../webview-ui/src/utils/message-dispatch"
import { ProviderContext, useProvider } from "../../webview-ui/src/context/provider"

const messages = []
window.__messages = messages
const Peer = window.RTCPeerConnection
window.__peers = []
window.RTCPeerConnection = class extends Peer {
  constructor(...args) {
    super(...args)
    window.__peers.push(this)
  }
  createOffer(...args) {
    if (window.__bridgeHold)
      return new Promise((_, reject) => {
        window.__bridgeReject = reject
      })
    return super.createOffer(...args)
  }
}
const AudioContext = window.AudioContext
window.__contexts = []
window.AudioContext = class extends AudioContext {
  constructor() {
    if (window.__preparation) throw new Error("Synthetic AudioContext preparation failure")
    super()
    window.__contexts.push(this)
  }
  resume() {
    messages.push({ type: "fixtureAudioResume", activated: navigator.userActivation.isActive })
    return super.resume()
  }
  close() {
    messages.push({ type: "fixtureAudioClose" })
    const job = super.close()
    if (window.__cleanup) throw new Error("Synthetic AudioContext cleanup failure")
    return job
  }
}
window.__deliver = (message) =>
  new Promise((resolve) => {
    const marker = crypto.randomUUID()
    const listener = (event) => {
      if (event.data.__barrier !== marker) return
      window.removeEventListener("message", listener)
      queueMicrotask(resolve)
    }
    window.addEventListener("message", listener)
    window.postMessage({ ...message, __barrier: marker }, "*")
  })
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => {
    messages.push(message)
    if (window.__host) void window.__host(message)
  },
})
window.__media = 0
Object.defineProperty(navigator, "mediaDevices", {
  value: {
    getUserMedia: () => {
      window.__media++
      throw new Error("Media is forbidden in this regression")
    },
  },
})

function Probe() {
  const session = useSession()
  window.__session = session
  window.__voice = useVoice()
  onMount(() => {
    window.postMessage({ type: "connectionState", state: "connected" }, "*")
    window.postMessage(
      {
        type: "speechSettingsLoaded",
        settings: {
          ...DEFAULT_SPEECH_SETTINGS,
          voiceEngine: "cascade-v1",
          sttEndpoint: "http://unused.invalid",
          hasSttKey: true,
          hasOpenAIKey: false,
          hasRealtimeKey: false,
          hasTtsKey: false,
        },
      },
      "*",
    )
    window.postMessage(
      {
        type: "agentsLoaded",
        defaultAgent: "code",
        agents: [
          { name: "voice", mode: "primary" },
          { name: "code", mode: "primary" },
        ],
      },
      "*",
    )
  })
  return (
    <>
      <PromptInput boxId="voice-mounted" />
      <output id="sid">{session.currentSessionID()}</output>
    </>
  )
}
function Routing(props) {
  const vscode = useVSCode()
  const listen = vscode.onMessage
  const handlers = new Set()
  vscode.onMessage = (handler) => {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }
  const unsubscribe = listen((message) =>
    dispatch(window.__reverse ? new Set([...handlers].reverse()) : handlers, message),
  )
  onCleanup(() => {
    unsubscribe()
    vscode.onMessage = listen
  })
  return props.children
}
function Registry(props) {
  const provider = useProvider()
  const current = provider.providers()
  const model = {
    ...current.kilo.models["anthropic/claude-sonnet-4-6"],
    id: "synthetic-pinned-4b",
    name: "Pinned fixture 4B",
  }
  const providers = { ...current, kilo: { ...current.kilo, models: { ...current.kilo.models, [model.id]: model } } }
  const models = [...provider.models(), { ...provider.models()[0], id: model.id, name: model.name }]
  return (
    <ProviderContext.Provider
      value={{
        ...provider,
        providers: () => providers,
        models: () => models,
        findModel: (selection) =>
          models.find((entry) => entry.providerID === selection.providerID && entry.id === selection.modelID),
      }}
    >
      {props.children}
    </ProviderContext.Provider>
  )
}
const [mounted, setMounted] = createSignal(true)
window.__unmount = () => setMounted(false)
render(
  () => (
    <StoryProviders noPadding config={{ model: "kilo/anthropic/claude-sonnet-4-6" }}>
      {mounted() && (
        <Routing>
          <Registry>
            <SessionProvider>
              <VoiceProvider>
                <Probe />
              </VoiceProvider>
            </SessionProvider>
          </Registry>
        </Routing>
      )}
    </StoryProviders>
  ),
  document.getElementById("root"),
)
