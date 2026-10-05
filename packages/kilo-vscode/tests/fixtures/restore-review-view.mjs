import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "restore-review-dom",
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
globalThis.acquireVsCodeApi = () => ({
  postMessage: (message) => sent.push(message),
  getState: () => ({}),
  setState: () => {},
})
const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { RestoreReview } = await import("../../webview-ui/src/components/routines/RestoreReview.tsx")
const root = document.createElement("div")
document.body.append(root)
const mount = () =>
  render(
    () =>
      createComponent(VSCodeProvider, {
        get children() {
          return createComponent(RestoreReview, {})
        },
      }),
    root,
  )
let dispose = mount()
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const emit = async (data) => {
  window.dispatchEvent(new window.MessageEvent("message", { data }))
  await tick()
}
const button = (label) => [...root.querySelectorAll("button")].find((node) => node.textContent.trim() === label)
const approve = () => sent.filter((message) => message.type === "restoreReviewApprove")
const reads = () => sent.filter((message) => message.type === "restoreReviewGet")
const saved = {
  state: "held",
  id: crypto.randomUUID(),
  revision: "a".repeat(64),
  reconnectCredentials: true,
  uncertainWork: "held-no-replay",
  workspaces: [{ source: "C:/Old/café 日本語 😀", destination: "D:/New/café 日本語 😀" }],
  workers: [{ id: "worker-one", name: "Paused worker café 日本語 😀", enabled: false }],
}
await tick()
assert.equal(reads().length, 1)
await emit({ type: "restoreReviewResult", requestID: "unrelated-view", summary: saved })
assert.equal(root.textContent.includes("Mapped folders"), false)
await emit({ type: "restoreReviewResult", requestID: reads()[0].requestID, summary: saved })
assert(root.textContent.includes(saved.workspaces[0].destination))
assert(root.textContent.includes(saved.workers[0].name))
assert.equal(button("Review this profile").disabled, true)
const boxes = [...root.querySelectorAll("input[type=checkbox]")]
assert.equal(boxes.length, 2)
for (const box of boxes) {
  assert.equal(box.checked, false)
  box.click()
  await tick()
}
assert.equal(button("Review this profile").disabled, false)
button("Review this profile").click()
await tick()
assert.equal(approve().length, 1)
assert.deepEqual(approve()[0].approval, {
  id: saved.id,
  revision: saved.revision,
  reviewed: true,
  workspacesAcknowledged: true,
  reconnectAcknowledged: true,
})
assert.equal(button("Review this profile").disabled, true)
await emit({ type: "restoreReviewResult", requestID: approve()[0].requestID, error: "The review changed. Reload it." })
assert(root.textContent.includes("The review changed. Reload it."))
assert.equal(button("Review this profile"), undefined)
button("Reload review").click()
await tick()
const read = sent.at(-1)
await emit({
  type: "restoreReviewResult",
  requestID: read.requestID,
  summary: { ...saved, revision: "b".repeat(64), workers: [{ ...saved.workers[0], enabled: true }] },
})
for (const box of root.querySelectorAll("input[type=checkbox]")) {
  box.click()
  await tick()
}
assert.equal(button("Review this profile").disabled, true)
assert.equal(approve().length, 1)
button("Reload review").click()
await tick()
const next = sent.at(-1)
await emit({
  type: "restoreReviewResult",
  requestID: next.requestID,
  summary: { ...saved, state: "released", review: { at: Date.now(), by: "user", revision: saved.revision } },
})
assert.equal(button("Review this profile"), undefined)
assert(root.textContent.includes("Enable each worker when you are ready"))
button("Reconnect credentials").click()
assert.deepEqual(sent.at(-1), { type: "openSettingsPanel", tab: "providers" })
assert.equal(
  sent.some((message) => ["routineRun", "routineUpdate", "sendMessage"].includes(message.type)),
  false,
)
dispose()
dispose = mount()
await tick()
await emit({
  type: "restoreReviewResult",
  requestID: reads().at(-1).requestID,
  summary: {
    ...saved,
    state: "absent",
    id: undefined,
    revision: undefined,
    workspaces: [],
    workers: [],
    reconnectCredentials: false,
  },
})
assert.equal(root.querySelector("section"), null)
dispose()
assert.equal(approve().length, 1)
console.log(
  JSON.stringify({
    passed: true,
    scope:
      "Actual mounted component, explicit acknowledgments, correlated replies, refusal/reload, credential navigation and zero worker dispatch. Backend acceptance independent.",
  }),
)
