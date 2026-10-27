import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/settings.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { I18nProvider } from "@kilocode/kilo-ui/context"
import { DialogProvider } from "@kilocode/kilo-ui/context/dialog"
import { ThemeProvider } from "@kilocode/kilo-ui/theme"
import { applyVscodeTheme } from "../../../kilo-ui/src/stories/theme-decorator"
import { ConfigProvider, useConfig } from "../../webview-ui/src/context/config"
import { VSCodeProvider } from "../../webview-ui/src/context/vscode"
import { SessionContext } from "../../webview-ui/src/context/session"
import { ServerContext } from "../../webview-ui/src/context/server"
import { LanguageContext } from "../../webview-ui/src/context/language"
import { t } from "../../webview-ui/src/stories/StoryProviders"
import ConnectionsTab from "../../webview-ui/src/components/settings/ConnectionsTab"

const theme = new URLSearchParams(location.search).get("theme") ?? "dark"
applyVscodeTheme(theme === "contrast" ? "hc-black" : theme === "light" ? "light-modern" : "dark-modern")
// VS Code supplies the webview page colors outside the component/provider tree.
document.body.style.background = "var(--vscode-sideBar-background)"
document.body.style.color = "var(--vscode-foreground)"

// Only host configuration messages and Session/Server snapshot/action boundaries are injected.
// Production ConnectionsTab, editor, ConfigProvider, dialogs and VS Code message handling run unchanged.
const messages = []
const actions = []
const reply = (data) => window.dispatchEvent(new MessageEvent("message", { data }))
const global = {
  mcp: {
    Global: {
      type: "remote",
      url: "https://secret-url.invalid/private",
      headers: { Authorization: "secret-header" },
      enabled: false,
    },
  },
}
const project = {
  mcp: {
    Project: {
      type: "local",
      command: ["secret-command", "secret-argument"],
      [new URLSearchParams(location.search).has("legacy") ? "env" : "environment"]: { TOKEN: "secret-environment" },
      enabled: true,
    },
  },
}
const config = {
  mcp: {
    ...global.mcp,
    ...project.mcp,
    System: { type: "remote", url: "https://system.invalid", enabled: true },
    Ambiguous: { type: "remote", url: "https://ambiguous.invalid" },
  },
}
const collections = {
  mcp: [
    { key: "Global", source: "global" },
    { key: "Project", source: "project" },
    { key: "System", source: "system" },
    { key: "Ambiguous", source: "global" },
    { key: "Ambiguous", source: "project" },
  ],
}
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => {
    messages.push(message)
    if (message.type === "requestConfig")
      queueMicrotask(() =>
        reply({
          type: "configLoaded",
          config,
          globalConfig: global,
          projectConfig: project,
          collections,
          features: {},
        }),
      )
  },
})
window.connections = { messages: () => messages, actions: () => actions }
function Fixture() {
  const cfg = useConfig()
  const [online, connect] = createSignal(true)
  const [status, observe] = createSignal({
    Global: { status: "connected" },
    Project: { status: "needs_auth" },
    System: { status: "disabled" },
  })
  const act = (type) => (name, directory) => actions.push({ type, name, directory })
  Object.assign(window.connections, {
    offline: () => connect(false),
    observed: (next) => observe(next),
    drafts: () => ({ global: cfg.globalDraft(), project: cfg.projectConfig() }),
  })
  return (
    <ServerContext.Provider value={{ isConnected: online, workspaceDirectory: () => "C:/fixture/workspace" }}>
      <SessionContext.Provider
        value={{
          mcpStatus: status,
          mcpLoading: () => null,
          connectMcp: act("connect"),
          disconnectMcp: act("disconnect"),
          authenticateMcp: act("authenticate"),
          removeMcp: act("remove"),
        }}
      >
        <main aria-label="Connections settings" style={{ padding: "12px" }}>
          <ConnectionsTab />
        </main>
        <button onClick={() => cfg.saveConfig()}>Save fixture settings</button>
        <button onClick={() => cfg.discardConfig()}>Discard fixture settings</button>
      </SessionContext.Provider>
    </ServerContext.Provider>
  )
}
render(
  () => (
    <ThemeProvider defaultTheme="kilo-vscode">
      <I18nProvider value={{ t, locale: () => "en", plural: (key) => t(key) }}>
        <LanguageContext.Provider value={{ t }}>
          <DialogProvider>
            <VSCodeProvider>
              <ConfigProvider>
                <Fixture />
              </ConfigProvider>
            </VSCodeProvider>
          </DialogProvider>
        </LanguageContext.Provider>
      </I18nProvider>
    </ThemeProvider>
  ),
  document.getElementById("root"),
)
