import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-inbox-dom",
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
let webview = { unrelated: "keep me" }
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => sent.push(msg),
  getState: () => webview,
  setState: (state) => {
    webview = state
  },
})
const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { default: RoutinesView } = await import("../../webview-ui/src/components/routines/RoutinesView.tsx")
const { status, Inbox } = await import("../../webview-ui/src/components/routines/Inbox.tsx")
const root = document.createElement("div")
document.body.append(root)
const mount = (workspace = "C:/Projects/Books", inbox) =>
  render(
    () =>
      createComponent(VSCodeProvider, {
        get children() {
          return createComponent(LanguageContext.Provider, {
            value: { locale: () => "en", setLocale: () => {}, userOverride: () => "", t: (key) => key },
            get children() {
              return createComponent(SessionContext.Provider, {
                value: { agents: () => [] },
                get children() {
                  return createComponent(DialogProvider, {
                    get children() {
                      return inbox ? createComponent(Inbox, inbox) : createComponent(RoutinesView, { workspace })
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

const [worker, setWorker] = createSignal("first")
const attachment = { id: "attachment", name: "notes.txt", mime: "text/plain", size: 12 }
const initial = {
  agentID: "first",
  state: "idle",
  draft: "Saved old text",
  draftRevision: 3,
  draftAttachments: [attachment],
}
const [box, setBox] = createSignal(initial)
const [connection, setConnection] = createSignal("connected")
const props = {
  get agentID() {
    return worker()
  },
  get box() {
    return box()
  },
  get connection() {
    return connection()
  },
  name: "Draft worker",
  role: "Reviewer",
  workspace: "Books",
  objective: "Review",
  schedule: "When you ask",
  manual: true,
  access: "Read only",
  output: "Report",
  enabled: false,
  canInspect: false,
  onEdit() {},
  onAccess() {},
  onOutput() {},
  onInspect() {},
  onToggle() {},
}
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const field = () => root.querySelector("textarea[aria-label='Message this worker']")
const type = (value) => {
  field().value = value
  field().dispatchEvent(new window.Event("input", { bubbles: true }))
}
let dispose = mount("C:/Projects/Books", props)
try {
  await tick()
  type("  Latest pending text\n  ")
  const cutoff = sent.length
  setBox(undefined)
  setWorker("second")
  await tick()
  const requests = sent.slice(cutoff).filter((msg) => msg.type === "routineInboxDraft")
  assert.equal(requests.length, 1)
  const first = requests[0]
  assert.equal(first.agentID, "first")
  assert.equal(first.draft, "  Latest pending text\n  ")
  assert.equal(first.revision, 4)
  assert.deepEqual(first.attachmentIDs, [attachment.id])
  assert.equal(field().value, "")
  // No invented save acknowledgement: reopening must retain the unresolved edit.
  setWorker("first")
  setBox(initial)
  await tick()
  assert.equal(field().value, first.draft)
  assert.match(root.textContent, /Your draft is still here/)
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
  // A mismatched revision is not a commit proof.
  emit({ type: "routineInboxDraft", requestID: first.requestID, agentID: "first", draft: first.draft, revision: 99 })
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
  type("Newer text after unresolved save")
  setBox(undefined)
  setWorker("second")
  await tick()
  const second = sent.findLast((msg) => msg.type === "routineInboxDraft")
  assert.equal(second.agentID, "first")
  assert.equal(second.draft, "Newer text after unresolved save")
  assert.ok(second.revision > first.revision)
  emit({
    type: "routineInboxDraft",
    requestID: second.requestID,
    agentID: "first",
    draft: second.draft,
    revision: second.revision,
    files: [],
  })
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
  // The exact late acknowledgement can settle only its original cached worker.
  emit({
    type: "routineInboxDraft",
    requestID: second.requestID,
    agentID: "first",
    draft: second.draft,
    revision: second.revision,
    files: [attachment],
  })
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, false)
  assert.equal(field().value, "")
  setWorker("first")
  setBox(initial)
  await tick()
  assert.equal(field().value, second.draft)
  // A disconnected transition keeps the edit locally and must not target a different worker.
  type("Offline retained text")
  setConnection("disconnected")
  const offline = sent.length
  setWorker("second")
  setBox(undefined)
  await tick()
  assert.equal(
    sent.slice(offline).some((msg) => msg.type === "routineInboxDraft"),
    false,
  )
  dispose()
  setWorker("first")
  setBox(initial)
  dispose = mount("C:/Projects/Books", props)
  await tick()
  assert.equal(field().value, "Offline retained text")
  const conflict = sent.length
  setBox({ agentID: "first", state: "idle", draft: "Newer saved work from another window", draftRevision: 20 })
  setConnection("connected")
  await tick()
  assert.equal(field().value, "Offline retained text")
  assert.equal(
    sent.slice(conflict).some((msg) => msg.type === "routineInboxDraft"),
    false,
  )
  assert.equal(webview.routineInbox.drafts["agent:first"].body, "Offline retained text")
  const saved = [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === "Use saved draft")
  assert.ok(saved)
  saved.click()
  await tick()
  assert.equal(field().value, "Newer saved work from another window")
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, false)
  assert.equal(
    sent.slice(conflict).some((msg) => msg.type === "routineInboxDraft"),
    false,
  )
  assert.equal(webview.unrelated, "keep me")
  console.log("mounted Routine draft recovery assertions passed; no SQL commit claim")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
