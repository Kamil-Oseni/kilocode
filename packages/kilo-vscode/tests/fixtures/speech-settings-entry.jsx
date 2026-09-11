import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/settings.css"
import "../../webview-ui/preview/preview.css"
import { render } from "solid-js/web"
import { StoryProviders } from "../../webview-ui/src/stories/StoryProviders"
import { VoiceProvider, useVoice } from "../../webview-ui/src/context/voice"
import SpeechTab from "../../webview-ui/src/components/settings/SpeechTab"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"

const messages = []
let captures = 0
const settings = {
  ...DEFAULT_SPEECH_SETTINGS,
  hasOpenAIKey: false,
  hasRealtimeKey: false,
  hasSttKey: false,
  hasTtsKey: false,
}
const emit = () =>
  queueMicrotask(() =>
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "speechSettingsLoaded", settings: { ...settings } } }),
    ),
  )
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => {
    messages.push(message)
    if (message.type === "speechSettingsRequest") emit()
    if (message.type === "speechSettingsUpdate") {
      Object.assign(settings, message.settings)
      emit()
    }
    if (message.type === "speechKeyUpdate" && message.kind === "openai") {
      settings.hasOpenAIKey = !!message.key
      emit()
    }
    const output = document.querySelector("[data-messages]")
    if (output) output.textContent = JSON.stringify(messages)
  },
})
Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
  value: async () => {
    captures++
    throw new Error("Fixture never captures a microphone")
  },
})
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
  const voice = useVoice()
  return (
    <main style={{ padding: "12px", "max-width": "760px", margin: "auto" }}>
      <h1>Speech settings</h1>
      <SpeechTab />
      <button
        onClick={() => {
          voice.start("fixture-session")
          document.querySelector("[data-captures]").textContent = String(captures)
        }}
      >
        Show missing-key error
      </button>
      <output data-messages hidden>
        {JSON.stringify(messages)}
      </output>
      <output data-captures hidden>
        0
      </output>
    </main>
  )
}
render(
  () => (
    <StoryProviders noPadding config={{}}>
      <VoiceProvider>
        <Fixture />
      </VoiceProvider>
    </StoryProviders>
  ),
  document.getElementById("root"),
)
