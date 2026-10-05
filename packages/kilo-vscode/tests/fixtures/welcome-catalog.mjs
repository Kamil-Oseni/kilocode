import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "composer-provider-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        configFile: false,
        babelrc: false,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          import.meta.resolve("@babel/preset-typescript"),
        ],
      })
      if (!result?.code) throw new Error("No compiled component")
      return { contents: result.code, loader: "js" }
    })
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
  },
})
const window = new Window()
for (const name of [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLHeadElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const sent = []
globalThis.acquireVsCodeApi = () => ({ postMessage: (msg) => sent.push(msg), getState: () => ({}), setState: () => {} })
const { createComponent, createSignal, onCleanup } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider, useVSCode } = await import("../../webview-ui/src/context/vscode.tsx")
const { ServerProvider } = await import("../../webview-ui/src/context/server.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { WelcomeEmptyState } = await import("../../webview-ui/src/components/chat/WelcomeEmptyState.tsx")
const root = document.createElement("div")
document.body.append(root)
const [sessions, setSessions] = createSignal([])
const draft = document.createElement("textarea")
draft.value = "UNSENT café 日本語 😀"
root.append(draft)
function Catalog() {
  const vscode = useVSCode()
  const unsubscribe = vscode.onMessage((msg) => {
    if (msg.type === "sessionsLoaded") setSessions(msg.sessions)
  })
  onCleanup(unsubscribe)
  return createComponent(SessionContext.Provider, {
    value: {
      sessions,
      currentSessionID: () => undefined,
      loadSessions: () => vscode.postMessage({ type: "loadSessions" }),
    },
    get children() {
      return createComponent(LanguageContext.Provider, {
        value: { t: (key) => key },
        get children() {
          return createComponent(DialogProvider, {
            get children() {
              return createComponent(WelcomeEmptyState, {})
            },
          })
        },
      })
    },
  })
}
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(ServerProvider, {
          get children() {
            return createComponent(Catalog, {})
          },
        })
      },
    }),
  root,
)
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const reads = () => sent.filter((msg) => msg.type === "loadSessions").length
assert.equal(reads(), 0)
emit({ type: "connectionState", state: "connecting" })
assert.equal(reads(), 0)
emit({ type: "ready", serverInfo: { port: 1 } })
assert.equal(reads(), 1)
assert.equal(root.textContent.includes("Restored saved chat"), false)
emit({
  type: "sessionsLoaded",
  sessions: [{ id: "ses_owned", title: "Restored saved chat", updatedAt: new Date(1).toISOString() }],
})
assert.equal(root.textContent.includes("Restored saved chat"), true)
emit({ type: "connectionState", state: "connected" })
assert.equal(reads(), 1)
emit({ type: "connectionState", state: "disconnected" })
emit({ type: "connectionState", state: "connected" })
assert.equal(reads(), 2)
assert.equal(draft.value, "UNSENT café 日本語 😀")
assert.equal(
  sent.some((msg) => msg.type === "sendMessage"),
  false,
)
dispose()
emit({ type: "connectionState", state: "disconnected" })
emit({ type: "connectionState", state: "connected" })
assert.equal(reads(), 2)
window.happyDOM.abort()
console.log("welcome catalog cold-start/reconnect passed")
