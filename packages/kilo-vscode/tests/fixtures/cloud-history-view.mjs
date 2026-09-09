import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "goal-view-dom",
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
    build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: "export default 'test-worker.js'", loader: "js" }))
  },
})
const window = new Window()
for (const name of [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "HTMLTextAreaElement",
  "HTMLDivElement",
  "getComputedStyle",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const sent = []
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => sent.push(msg),
  getState: () => undefined,
  setState: () => {},
})
const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { default: CloudSessionList } = await import("../../webview-ui/src/components/history/CloudSessionList.tsx")
const selected = []
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: { t: (key) => key },
          get children() {
            return createComponent(CloudSessionList, { onSelectSession: (id) => selected.push(id) })
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const send = (data) => window.dispatchEvent(new MessageEvent("message", { data }))
const request = () => sent.filter((message) => message.type === "requestCloudSessions").at(-1)
const row = (id, title = id) => ({
  session_id: id,
  title,
  updated_at: "2026-09-09T12:00:00Z",
  created_at: "2026-09-09T12:00:00Z",
})
const loaded = (requestID, sessions, nextCursor = null) =>
  send({ type: "cloudSessionsLoaded", requestID, sessions, nextCursor })
const button = (text) => [...root.querySelectorAll("button")].find((item) => item.textContent.includes(text))
const active = () => root.querySelector('[data-slot="list-item"][data-active="true"]')?.getAttribute("data-key")
try {
  await tick()
  send({ type: "gitRemoteUrlLoaded", gitUrl: "repo-a" })
  await tick()
  const first = request()
  assert.equal(first.gitUrl, "repo-a")
  const checkbox = root.querySelector('input[type="checkbox"]')
  assert.ok(checkbox)
  checkbox.click()
  await tick()
  const second = request()
  assert.notEqual(second.requestID, first.requestID)
  assert.equal(second.gitUrl, undefined)
  loaded(second.requestID, [row("alpha", "Alpha task"), row("beta", "Beta task")], "page2")
  await tick()
  loaded(first.requestID, [row("stale", "Wrong repository")])
  await tick()
  assert.doesNotMatch(root.textContent, /Wrong repository/)
  assert.match(root.textContent, /Alpha task/)
  const input = root.querySelector('[data-slot="list-search"] input')
  assert.ok(input)
  input.focus()
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  await tick()
  assert.equal(active(), "beta")
  button("Refresh cloud history").click()
  await tick()
  const refresh = request()
  assert.match(root.textContent, /Beta task/)
  loaded(refresh.requestID, [row("new", "New task"), row("alpha", "Alpha task"), row("beta", "Beta updated")], "page2")
  await tick()
  assert.equal(active(), "beta")
  assert.equal(document.activeElement, input)
  assert.deepEqual(selected, [])
  const focused = root.querySelector('[data-key="beta"]')
  focused.focus()
  assert.equal(document.activeElement?.getAttribute("data-key"), "beta")
  button("common.loadMore").click()
  await tick()
  const page = request()
  assert.equal(page.cursor, "page2")
  send({ type: "cloudSessionsFailed", requestID: page.requestID, error: "Temporary failure" })
  await tick()
  assert.equal(root.firstElementChild.getAttribute("aria-busy"), "false")
  assert.match(root.textContent, /Temporary failure/)
  assert.match(root.textContent, /Beta updated/)
  button("Retry cloud history").click()
  await tick()
  const retry = request()
  assert.equal(retry.cursor, "page2")
  assert.notEqual(retry.requestID, page.requestID)
  loaded(retry.requestID, [row("beta", "Duplicate"), row("gamma", "Gamma task")])
  await tick()
  assert.equal(root.querySelectorAll('[data-key="beta"]').length, 1)
  assert.equal(active(), "beta")
  assert.match(root.textContent, /Gamma task/)
  assert.equal(document.activeElement?.getAttribute("data-key"), "beta")
  button("Refresh cloud history").click()
  await tick()
  loaded(request().requestID, [row("new", "New task"), row("alpha", "Alpha task")])
  await tick()
  assert.equal(active(), "new")
  input.value = "Alpha"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await tick()
  assert.equal(active(), "alpha")
  assert.deepEqual(selected, [])
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await tick()
  assert.deepEqual(selected, ["alpha"])
  button("Refresh cloud history").click()
  await tick()
  const late = request()
  checkbox.click()
  await tick()
  const filtered = request()
  assert.equal(filtered.gitUrl, "repo-a")
  loaded(filtered.requestID, [row("alpha", "Alpha repository")])
  send({ type: "cloudSessionsFailed", requestID: late.requestID, error: "Stale error" })
  loaded(late.requestID, [row("bad", "Stale appended data")])
  await tick()
  assert.doesNotMatch(root.textContent, /Stale error|Stale appended data/)
  assert.match(root.textContent, /Alpha repository/)
  input.value = "No matching task"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await tick()
  assert.equal(active(), undefined)
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await tick()
  assert.deepEqual(selected, ["alpha"])
  input.value = ""
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await tick()
  button("Refresh cloud history").click()
  await tick()
  loaded(request().requestID, [])
  await tick()
  assert.equal(active(), undefined)
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await tick()
  assert.deepEqual(selected, ["alpha"])
  button("Refresh cloud history").click()
  await tick()
  loaded(request().requestID, [row("alpha", "Alpha task")])
  await tick()
  root.querySelector('[data-key="alpha"]').focus()
  button("Refresh cloud history").click()
  await tick()
  loaded(request().requestID, [row("alpha", "Alpha refreshed")])
  const control = button("Refresh cloud history")
  control.focus()
  await tick()
  assert.equal(document.activeElement === control, true)
  assert.deepEqual(selected, ["alpha"])
  console.log("Cloud history production component assertions passed")
} finally {
  dispose()
  await window.happyDOM.close()
}
