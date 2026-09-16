import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-inbox-state-dom",
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
  "HTMLTextAreaElement",
  "Event",
  "KeyboardEvent",
  "MessageEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
const sent = []
globalThis.acquireVsCodeApi = () => ({ postMessage: (msg) => sent.push(msg), getState: () => ({}), setState: () => {} })

const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { Inbox } = await import("../../webview-ui/src/components/routines/Inbox.tsx")
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(Inbox, {
          agentID: "books",
          name: "Books",
          role: "accountant",
          objective: "Review accounts",
          schedule: "Every Friday",
          access: "Read and report",
          output: "Weekly report",
          enabled: true,
          canInspect: false,
          box: {
            agentID: "books",
            conversationID: "rcv_books",
            name: "Books",
            role: "accountant",
            unread: 0,
            state: "scheduled",
          },
          onEdit: () => {},
          onAccess: () => {},
          onOutput: () => {},
          onInspect: () => {},
          onToggle: () => {},
        })
      },
    }),
  root,
)
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))

try {
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(root.querySelector("[role='log']")?.getAttribute("aria-busy"), "true")
  assert.equal(root.querySelectorAll(".routines-line-skeleton").length, 3)
  const first = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.ok(first)

  emit({
    type: "routineInboxPage",
    requestID: first.requestID,
    agentID: "books",
    error: "The persisted conversation is unavailable.",
  })
  await Promise.resolve()
  assert.equal(root.querySelector("[role='log']")?.getAttribute("aria-busy"), "false")
  assert.match(root.textContent, /The persisted conversation is unavailable/)
  const retry = [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === "Retry")
  assert.ok(retry)
  retry.click()
  await Promise.resolve()
  const second = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.notEqual(second.requestID, first.requestID)
  assert.equal(second.search, undefined)
  assert.equal(root.querySelector("[role='log']")?.getAttribute("aria-busy"), "true")

  emit({ type: "routineInboxPage", requestID: second.requestID, agentID: "books", messages: [] })
  await Promise.resolve()
  assert.match(root.textContent, /Reports and follow-ups/)

  const search = root.querySelector("input[type='search']")
  assert.ok(search)
  search.value = "tax"
  search.dispatchEvent(new window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const filtered = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(filtered.search, "tax")
  assert.equal(root.querySelectorAll(".routines-line-skeleton").length, 3)
  emit({ type: "routineInboxPage", requestID: filtered.requestID, agentID: "books", messages: [] })
  await Promise.resolve()
  assert.match(root.textContent, /No messages match this search/)
  console.log("routine-inbox-state: initial load, failure, retry, empty, and filtered-empty assertions passed")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
