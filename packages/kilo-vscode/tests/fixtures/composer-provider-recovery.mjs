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
const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { ProviderProvider } = await import("../../webview-ui/src/context/provider.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { ComposerConfiguration } = await import("../../webview-ui/src/components/chat/ComposerConfiguration.tsx")
const root = document.createElement("div")
document.body.append(root)
const original = { providerID: "qwen-local", modelID: "qwen3-raya-32k:latest" }
const [selection, select] = createSignal(original)
const draft = document.createElement("textarea")
draft.value = "Keep this unsent — café 日本語 😀."
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(ProviderProvider, {
          get children() {
            return createComponent(LanguageContext.Provider, {
              value: { t: (key) => key },
              get children() {
                return createComponent(SessionContext.Provider, {
                  value: {
                    selected: selection,
                    selectedAgent: () => "auto",
                    agents: () => [{ name: "auto", displayName: "Auto" }],
                  },
                  get children() {
                    return createComponent(ComposerConfiguration, {
                      sessionID: () => "session",
                      scope: "test",
                      children: draft,
                    })
                  },
                })
              },
            })
          },
        })
      },
    }),
  root,
)
const emit = (data) => window.dispatchEvent(new MessageEvent("message", { data }))
const status = () => root.querySelector('[role="status"]')?.textContent
const retry = () => [...root.querySelectorAll("button")].find((button) => button.textContent === "common.retry")
const stable = () => {
  assert.equal(selection(), original)
  assert.equal(draft.value, "Keep this unsent — café 日本語 😀.")
  assert.equal(root.querySelector("textarea"), draft)
  assert.equal(root.querySelector("button button"), null)
}
const loaded = (generation, valid = true) =>
  emit({
    type: "providersLoaded",
    generation,
    providers: valid
      ? {
          "qwen-local": {
            id: "qwen-local",
            name: "Local",
            models: { [original.modelID]: { id: original.modelID, name: "Qwen3 8B local 32K" } },
          },
        }
      : {},
    connected: valid ? ["qwen-local"] : [],
    defaults: {},
    defaultSelection: original,
    authMethods: {},
    authStates: {},
  })
assert.equal(status(), "settings.providers.loading")
assert.equal(retry(), undefined)
stable()
emit({ type: "providersLoadState", state: "error", generation: 1, error: "Never display internal details" })
assert.equal(status(), "settings.providers.failed")
assert.equal(root.textContent.includes("Never display internal details"), false)
retry().click()
assert.equal(sent.at(-1).type, "requestProviders")
assert.equal(status(), "settings.providers.loading")
assert.equal(retry(), undefined)
loaded(2)
assert.equal(status(), undefined)
assert.equal(root.textContent.includes("Qwen3 8B local 32K"), true)
stable()
emit({ type: "connectionState", state: "disconnected" })
assert.equal(status(), "settings.providers.disconnected")
assert.equal(root.textContent.includes("Qwen3 8B local 32K"), true)
retry().click()
assert.equal(sent.at(-1).type, "retryConnection")
assert.equal(status(), "settings.providers.loading")
loaded(2)
assert.equal(status(), "settings.providers.loading")
emit({ type: "connectionState", state: "connected" })
loaded(3)
assert.equal(status(), undefined)
stable()
emit({ type: "providersLoadState", state: "error", generation: 4 })
assert.equal(status(), "settings.providers.failed")
retry().click()
loaded(5, false)
assert.equal(status(), "composer.configuration.unavailable")
assert.equal(retry(), undefined)
stable()
select(null)
assert.equal(status(), "composer.configuration.choose")
select(original)
loaded(6)
assert.equal(status(), undefined)
stable()
dispose()
const count = sent.length
emit({ type: "providersLoadState", state: "error", generation: 7 })
assert.equal(root.textContent, "")
assert.equal(sent.length, count)
console.log(
  "Composer provider recovery: loading, error, cached disconnect, retry, missing model, draft and selection preservation passed",
)
await window.happyDOM.close()
