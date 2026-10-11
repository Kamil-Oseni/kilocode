import "@kilocode/kilo-ui/styles"
import { createSignal, onMount, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { SessionProvider, useSession } from "../../webview-ui/src/context/session"
import { VoiceProvider, useVoice } from "../../webview-ui/src/context/voice"
import { PromptInput } from "../../webview-ui/src/components/chat/PromptInput"
import { LocalTabsProvider, useLocalTabs } from "../../webview-ui/src/context/local-tabs"
import { tabTitle } from "../../webview-ui/src/utils/session-title"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"
import { useVSCode } from "../../webview-ui/src/context/vscode"
import { dispatch } from "../../webview-ui/src/utils/message-dispatch"
import { ProviderContext, ProviderProvider, useProvider } from "../../webview-ui/src/context/provider"
import { DurableDrafts } from "../../webview-ui/src/utils/durable-drafts"

const acquire = DurableDrafts.prototype.insertion
const capture = DurableDrafts.prototype.capture
window.__speechGuards = []
DurableDrafts.prototype.capture = async function (identity) {
  const observe = (phase, accepted) => {
    const view = this.view(identity)
    if (window.__speechGuards.length < 128)
      window.__speechGuards.push({
        phase,
        accepted,
        owner: !!view.owner,
        loaded: view.loaded,
        stored: view.stored,
        error: view.error,
        revision: view.revision,
        text: view.content.text.length,
      })
  }
  observe("capture-start")
  const result = await capture.call(this, identity)
  observe("capture-end", !!result)
  return result
}
window.__speechGates = []
window.__speechGate = (index, value) => {
  if (window.__speechGates.length < 128) window.__speechGates.push({ index, accepted: !!value })
  return value
}
DurableDrafts.prototype.insertion = function (identity) {
  const original = acquire.call(this, identity)
  const record = (value) => {
    if (window.__speechGuards.length < 128) window.__speechGuards.push(value)
  }
  return Object.assign(
    (current) => {
      const owned = original(current)
      record({ phase: "owned", owned })
      return owned
    },
    {
      settle: async (current, signal, stable) => {
        const accepted = await original.settle(current, signal, () => {
          const same = stable()
          record({ phase: "stable", same })
          return same
        })
        record({ phase: "settled", accepted })
        return accepted
      },
    },
  )
}

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
  getState: () => window.__saved,
  setState: (value) => {
    window.__saved = value
  },
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
  const tabs = useLocalTabs()
  const [box, setBox] = createSignal("voice-mounted")
  const [composer, setComposer] = createSignal(true)
  window.__composer = setComposer
  window.__box = setBox
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
          { name: "auto", mode: "primary" },
          { name: "code", mode: "primary" },
        ],
      },
      "*",
    )
  })
  return (
    <>
      {composer() && <PromptInput boxId={box()} pendingSessionID={tabs?.pending()} />}
      <output id="sid">{session.currentSessionID()}</output>
      <output id="title">{tabTitle(tabs?.active(), session.currentSession(), "Untitled chat")}</output>
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
  return (
    <ProviderProvider>
      <Catalog provider={provider}>{props.children}</Catalog>
    </ProviderProvider>
  )
}
function Catalog(props) {
  const actual = useProvider()
  const provider = props.provider
  // Accepted catalog updates use the actual provider's signal and generation guard.
  window.__auth = (authStates) =>
    window.__deliver({
      type: "providersLoaded",
      providers: provider.providers(),
      connected: provider.connected(),
      defaults: provider.defaults(),
      defaultSelection: provider.defaultSelection(),
      authMethods: provider.authMethods(),
      authStates,
      generation: 0,
    })
  const current = provider.providers()
  const model = {
    ...current.kilo.models["anthropic/claude-sonnet-4-6"],
    id: "synthetic-pinned-4b",
    name: "Pinned fixture 4B",
    ...(window.__typedVariants ? { variants: { original: {}, next: {} } } : {}),
  }
  const providers = { ...current, kilo: { ...current.kilo, models: { ...current.kilo.models, [model.id]: model } } }
  const models = [
    ...provider.models(),
    {
      ...provider.models()[0],
      id: model.id,
      name: model.name,
      ...(window.__typedVariants ? { variants: model.variants } : {}),
    },
  ]
  return (
    <ProviderContext.Provider
      value={{
        ...provider,
        authStates: actual.authStates,
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
function Sidebar(props) {
  return window.__tabs ? <LocalTabsProvider>{props.children}</LocalTabsProvider> : props.children
}
const [mounted, setMounted] = createSignal(true)
window.__unmount = () => setMounted(false)
window.__mount = () => setMounted(true)
render(
  () => (
    <StoryProviders noPadding config={{ model: "kilo/anthropic/claude-sonnet-4-6" }}>
      {mounted() && (
        <Routing>
          <Registry>
            <SessionProvider>
              <Sidebar>
                <VoiceProvider>
                  <Probe />
                </VoiceProvider>
              </Sidebar>
            </SessionProvider>
          </Registry>
        </Routing>
      )}
    </StoryProviders>
  ),
  document.getElementById("root"),
)
