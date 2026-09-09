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
const { GoalEvidence } = await import("../../webview-ui/src/components/chat/GoalEvidence.tsx")
const [owner, setOwner] = createSignal("owner")
const [ref, setRef] = createSignal({
  sessionID: "child",
  messageID: "message",
  partID: "part",
  callID: "call",
  summary: "summary",
})
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: { t: (key) => key },
          get children() {
            return createComponent(GoalEvidence, {
              get sessionID() {
                return owner()
              },
              get evidence() {
                return ref()
              },
            })
          },
        })
      },
    }),
  root,
)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const click = (text) => {
  const button = [...root.querySelectorAll("button")].find((item) => item.textContent.includes(text))
  assert.ok(button, `Missing ${text}`)
  button.click()
}
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const response = (request, source) =>
  emit({ type: "goalEvidenceResult", sessionID: request.sessionID, requestID: request.requestID, source })
const source = {
  inspection: {
    kind: "text",
    coverage: "partial",
    lineStart: 2,
    lineEnd: 3,
    reportedLines: 10,
    fullReview: "not-established",
  },
  tool: "read",
  status: "completed",
  input: "{}",
  output: "<script>untrusted()</script>",
  metadata: "{}",
  truncated: false,
}
await tick()
click("View source")
await tick()
const first = sent.at(-1)
assert.equal(first.type, "goalEvidence")
assert.deepEqual(first.evidence, ref())
response({ ...first, requestID: "wrong" }, source)
await tick()
assert.ok(root.textContent.includes("Loading cited result"))
response(first, source)
await tick()
assert.ok(root.textContent.includes(source.output))
assert.ok(root.textContent.includes("Displayed lines 2–3"))
assert.ok(root.textContent.includes("Only part of the text was displayed"))
assert.equal(root.querySelector("script"), null)
assert.ok(root.textContent.includes("does not rerun verification"))
click("Hide source")
click("View source")
await tick()
const second = sent.at(-1)
click("Hide source")
response(second, source)
await tick()
assert.ok(!root.textContent.includes(source.output))
click("View source")
await tick()
const third = sent.at(-1)
emit({
  type: "goalEvidenceResult",
  sessionID: third.sessionID,
  requestID: third.requestID,
  error: "Source unavailable",
})
await tick()
assert.ok(root.textContent.includes("Source unavailable"))
click("Retry")
await tick()
const fourth = sent.at(-1)
assert.notEqual(fourth.requestID, third.requestID)
setOwner("other")
await tick()
response(fourth, source)
await tick()
assert.ok(!root.textContent.includes(source.output))
click("View source")
await tick()
const fifth = sent.at(-1)
await new Promise((resolve) => setTimeout(resolve, 15_100))
assert.ok(root.textContent.includes("request timed out"))
response(fifth, source)
await tick()
assert.ok(!root.textContent.includes(source.output))
click("Retry")
await tick()
const sixth = sent.at(-1)
assert.notEqual(sixth.requestID, fifth.requestID)
response(sixth, { ...source, truncated: true, receipt: "matching" })
await tick()
assert.ok(root.textContent.includes("preview is truncated"))
assert.ok(root.textContent.includes("Matches the result recorded by the accepted audit"))
assert.equal(root.querySelector('pre[aria-label="Recorded tool output"]').tabIndex, 0)
setRef({ callID: "legacy", summary: "old" })
await tick()
assert.ok(root.textContent.includes("Exact source identity was not recorded"))
assert.equal(root.querySelector("button"), null)
dispose()
const { GoalInspection } = await import("../../webview-ui/src/components/chat/GoalInspection.tsx")
const [coverage, setCoverage] = createSignal({ kind: "directory", coverage: "listing" })
const panel = document.createElement("div")
document.body.append(panel)
const cleanup = render(
  () =>
    createComponent(GoalInspection, {
      get inspection() {
        return coverage()
      },
    }),
  panel,
)
await tick()
assert.ok(panel.textContent.includes("did not inspect their file contents"))
setCoverage({ kind: "unknown", coverage: "unknown" })
await tick()
assert.ok(panel.textContent.includes("could not be verified"))
setCoverage({
  kind: "text",
  coverage: "displayed",
  lineStart: 1,
  lineEnd: 0,
  reportedLines: 0,
  fullReview: "not-established",
})
await tick()
assert.ok(panel.textContent.includes("text extraction was empty"))
setCoverage({
  kind: "text",
  coverage: "displayed",
  lineStart: 1,
  lineEnd: 3,
  reportedLines: 3,
  fullReview: "not-established",
})
await tick()
assert.ok(panel.textContent.includes("recorded text range was displayed"))
assert.ok(panel.textContent.includes("does not establish a full review"))
setCoverage(undefined)
await tick()
assert.equal(panel.textContent, "")
cleanup()
window.happyDOM.abort()
console.log("Goal source UI identity, text rendering, retry, close and session isolation passed")
