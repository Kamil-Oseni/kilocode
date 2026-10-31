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
const { RunReview } = await import("../../webview-ui/src/components/routines/RunReview.tsx")
const root = document.createElement("div")
document.body.append(root)
const mount = (workspace = "C:/Projects/Books", inbox, review) =>
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
                      return review
                        ? createComponent(RunReview, review)
                        : inbox
                          ? createComponent(Inbox, inbox)
                          : createComponent(RoutinesView, { workspace })
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
  owner: "owner-a",
  conversationID: "conversation-a",
  state: "idle",
  draft: "Saved old text",
  draftRevision: 3,
  draftAttachments: [attachment],
}
const [box, setBox] = createSignal(initial)
const [connection, setConnection] = createSignal("connected")
const [correction, setCorrection] = createSignal()
const consumed = []
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
  get correction() {
    return correction()
  },
  onCorrectionConsumed(nonce) {
    consumed.push(nonce)
    if (correction()?.nonce === nonce) setCorrection()
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
  const mounted = sent.findLast((msg) => msg.type === "routineInboxMount")
  assert.ok(mounted, `mount requests: ${JSON.stringify(sent.slice(-8))}`)
  assert.equal(mounted.owner, initial.owner)
  assert.equal(mounted.conversationID, initial.conversationID)
  emit({ ...mounted, type: "routineInboxMounted" })
  type("  Latest pending text\n  ")
  await new Promise((resolve) => setTimeout(resolve, 450))
  const write = sent.findLast((msg) => msg.type === "routineInboxDraft")
  assert.ok(write)
  assert.equal(write.owner, initial.owner)
  assert.equal(write.conversationID, initial.conversationID)
  assert.equal(write.expectedRevision, 3)
  assert.deepEqual(write.attachmentIDs, [attachment.id])
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
  const target = { nonce: "correction-first", agentID: "first", runID: "old-result", sessionID: "session-old", at: 1 }
  setCorrection(target)
  await tick()
  assert.equal(field().value, "  Latest pending text\n  ", "wait for restored conversation before preparing correction")
  const page = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    ...page,
    type: "routineInboxPage",
    messages: [],
    draftState: {
      owner: initial.owner,
      conversationID: initial.conversationID,
      revision: 3,
      draft: initial.draft,
      attachments: [attachment],
    },
  })
  await tick()
  const prepared = field().value
  assert.ok(prepared.startsWith("  Latest pending text\n  "))
  assert.match(prepared, /run old-result, conversation session-old/)
  assert.deepEqual(consumed, [target.nonce])
  assert.deepEqual(webview.routineInbox.drafts["agent:first"].files, [attachment])
  assert.equal(
    sent.some((msg) => msg.type === "routineInboxSend"),
    false,
  )
  // A late successful save of the old text must queue the merged correction rather than erase it.
  emit({ ...write, type: "routineInboxDraft", revision: 4, files: [attachment] })
  await tick()
  const merged = sent.findLast((msg) => msg.type === "routineInboxDraft")
  assert.notEqual(merged.requestID, write.requestID)
  assert.equal(merged.draft, prepared)
  assert.equal(merged.expectedRevision, 4)
  assert.deepEqual(merged.attachmentIDs, [attachment.id])
  assert.equal(field().value, prepared)
  setCorrection(target)
  await tick()
  assert.equal(field().value, prepared, "same preparation nonce must not append twice")
  setCorrection()

  // A response with the wrong owner or revision cannot settle local cache.
  emit({ ...merged, type: "routineInboxDraft", owner: "foreign", revision: 5, files: [attachment] })
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
  type("Final unsaved text")
  setBox(undefined)
  setWorker("second")
  await tick()
  const flush = sent.findLast((msg) => msg.type === "routineInboxFlush")
  assert.ok(flush)
  assert.equal(flush.agentID, "first")
  assert.equal(flush.owner, initial.owner)
  assert.equal(flush.conversationID, initial.conversationID)
  assert.equal(flush.draft, "Final unsaved text")
  assert.deepEqual(flush.attachmentIDs, [attachment.id])
  assert.equal(field().value, "")
  emit({
    type: "routineInboxFlushed",
    requestID: flush.requestID,
    paneID: flush.paneID,
    agentID: "first",
    committed: false,
  })
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
  assert.equal(sent.findLast((msg) => msg.type === "routineInboxUnmount")?.paneID, undefined)
  const other = { id: "other-attachment", name: "other.txt", mime: "text/plain", size: 4 }
  const second = {
    ...initial,
    agentID: "second",
    owner: "owner-second",
    conversationID: "conversation-second",
    draft: "Second worker draft",
    draftAttachments: [other],
    draftRevision: 2,
  }
  setBox(second)
  await tick()
  const secondMount = sent.findLast((msg) => msg.type === "routineInboxMount" && msg.agentID === "second")
  emit({ ...secondMount, type: "routineInboxMounted" })
  const secondPage = sent.findLast((msg) => msg.type === "routineInboxPage" && msg.agentID === "second")
  emit({
    ...secondPage,
    type: "routineInboxPage",
    messages: [],
    draftState: {
      owner: second.owner,
      conversationID: second.conversationID,
      revision: 2,
      draft: second.draft,
      attachments: [other],
    },
  })
  setCorrection({ ...target, nonce: "foreign-worker" })
  await tick()
  assert.equal(field().value, second.draft, "a first-worker correction cannot enter the second-worker draft")
  setCorrection({ ...target, agentID: "second", nonce: "correction-second", runID: "old-second-result" })
  await tick()
  assert.ok(field().value.startsWith(second.draft))
  assert.match(field().value, /run old-second-result/)
  assert.deepEqual(webview.routineInbox.drafts["agent:second"].files, [other])
  assert.equal(field().value.includes("Final unsaved text"), false)
  assert.equal(
    sent.some((msg) => msg.type === "routineInboxSend"),
    false,
  )

  // Reopening cannot reuse an old pane's reply or cross a new conversation.
  setWorker("first")
  setBox(initial)
  await tick()
  assert.equal(field().value, "Final unsaved text")
  const newer = sent.findLast((msg) => msg.type === "routineInboxMount")
  assert.notEqual(newer.paneID, mounted.paneID)
  emit({ ...newer, type: "routineInboxMounted" })
  setConnection("disconnected")
  type("Offline retained text")
  const cutoff = sent.length
  setBox(undefined)
  setWorker("second")
  await tick()
  assert.equal(
    sent.slice(cutoff).some((msg) => msg.type === "routineInboxDraft"),
    false,
  )
  dispose()
  setWorker("first")
  setBox({ ...initial, owner: "owner-b", conversationID: "conversation-b", draft: "Other conversation" })
  dispose = mount("C:/Projects/Books", props)
  await tick()
  assert.equal(field().value, "Offline retained text")
  assert.equal(webview.routineInbox.drafts["agent:first"].pending, true)
  assert.equal(webview.unrelated, "keep me")
  dispose()
  const requested = []
  dispose = mount("C:/Projects/Books", undefined, {
    id: "review",
    name: "Draft worker",
    agentID: "first",
    selected: "old",
    runs: [
      { id: "old", at: 1, status: "complete", sessionID: "session-old" },
      { id: "new", at: 2, status: "complete", sessionID: "session-new" },
    ],
    onClose() {},
    onRequestChanges: (target) => requested.push(target),
  })
  await tick()
  const button = [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === "Request changes")
  assert.ok(button)
  button.click()
  assert.deepEqual(requested, [{ agentID: "first", runID: "old", sessionID: "session-old", at: 1 }])
  assert.equal(
    sent.some((msg) => msg.type === "routineInboxSend"),
    false,
  )
  console.log(
    "mounted Routine draft correction, exact old-run binding, ownership and recovery assertions passed; no SQL commit claim",
  )
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
