import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "memory-provenance-dom",
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
  "customElements",
  "DocumentFragment",
  "ShadowRoot",
  "CSSStyleSheet",
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
document.insertBefore(document.implementation.createDocumentType("html", "", ""), document.documentElement)
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
const { For, createMemo } = await import("solid-js")
const { DataProvider } = await import("@kilocode/kilo-ui/context/data")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { ConfigContext } = await import("../../webview-ui/src/context/config.tsx")
const { DisplayContext } = await import("../../webview-ui/src/context/display.tsx")
const { AssistantMessage } = await import("../../webview-ui/src/components/chat/AssistantMessage.tsx")
const { transcriptRows } = await import("../../webview-ui/src/context/transcript-rows.ts")
const { isRenderable, coalesceToolRows } = await import("../../webview-ui/src/utils/transcript-parts.ts")
const { provenance } = await import("../../src/shared/memory-provenance.ts")
const message = {
  id: "assistant",
  sessionID: "owner",
  parentID: "user",
  role: "assistant",
  time: { created: 1, completed: 2 },
  tokens: {},
  cost: 0,
}
const user = { id: "user", sessionID: "owner", role: "user", time: { created: 0 } }
const marker = (id, value) => ({
  id,
  messageID: "assistant",
  sessionID: "owner",
  type: "text",
  text: "",
  synthetic: true,
  ignored: true,
  metadata: { kiloMemory: value },
})
const prepared = marker("startup", {
  type: "startup",
  count: 3,
  tokens: 120,
  files: ["project.md", "environment.md"],
  captured: 42,
  scope: { directory: "/recorded-worktree", project: "/recorded-project" },
  items: ["PRIVATE STARTUP CONTENT"],
})
const recalled = marker("recall", {
  type: "recall",
  tokens: 12,
  sources: ["corrections.md"],
  items: ["PRIVATE RECALL CONTENT"],
})
const [parts, setParts] = createSignal([prepared, recalled])
const root = document.createElement("div")
document.body.append(root)
const providers = [
  [VSCodeProvider, {}],
  [LanguageContext.Provider, { value: { t: (key) => key } }],
  [SessionContext.Provider, { value: { questions: () => [], suggestions: () => [] } }],
  [ConfigContext.Provider, { value: { config: () => ({}) } }],
  [DisplayContext.Provider, { value: { throughputVisible: () => false, reasoningAutoCollapse: () => false } }],
  [
    DataProvider,
    {
      data: { session: [], session_status: {}, session_diff: {}, message: {}, part: {} },
      directory: "/unrelated-current-project",
    },
  ],
]
function tree(index = 0) {
  if (index === providers.length) {
    const rows = createMemo(() =>
      transcriptRows([{ id: "turn", user, assistant: [message], partial: true }], () => parts(), { size: 1 }),
    )
    return createComponent(For, {
      get each() {
        return rows()
      },
      children: (row) => createComponent(AssistantMessage, { message: row.message, parts: row.parts }),
    })
  }
  const [component, props] = providers[index]
  return createComponent(component, {
    ...props,
    get children() {
      return tree(index + 1)
    },
  })
}
const dispose = render(() => tree(), root)
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const cards = () => [...root.querySelectorAll('[data-component="memory-provenance"]')]
try {
  await tick()
  assert.equal(cards().length, 2)
  assert.match(root.textContent, /Memory prepared for this step/)
  assert.match(root.textContent, /Memory retrieved during this step/)
  assert.match(root.textContent, /Item count not recorded/)
  assert.doesNotMatch(root.textContent, /PRIVATE|recorded-worktree|corrections.md/)
  const triggers = cards().map((card) => card.querySelector("button"))
  assert.equal(
    triggers.every((button) => button.getAttribute("aria-expanded") === "false"),
    true,
  )
  triggers[0].click()
  triggers[1].click()
  await tick()
  assert.equal(
    triggers.every((button) => button.getAttribute("aria-expanded") === "true"),
    true,
  )
  assert.match(root.textContent, /Recorded sources/)
  assert.match(root.textContent, /project.md/)
  assert.match(root.textContent, /corrections.md/)
  assert.match(root.textContent, /Recorded working directory: \/recorded-worktree/)
  assert.match(root.textContent, /Recorded memory scope: \/recorded-project/)
  assert.match(root.textContent, /Preparation or retrieval time was not recorded/)
  assert.match(root.textContent, /Working-directory scope was not recorded/)
  assert.match(root.textContent, /Memory-project scope was not recorded/)
  assert.match(root.textContent, /not a complete context inventory or proof/)
  assert.match(root.textContent, /does not establish whether the stored facts are still current/)
  assert.match(root.textContent, /reused from the session's prepared snapshot/)
  assert.match(root.textContent, /historical receipt is read-only/)
  assert.doesNotMatch(root.textContent, /PRIVATE|unrelated-current-project/)
  assert.equal(root.querySelectorAll("a").length, 0)
  assert.equal(
    sent.some((item) => ["memoryOperation", "memoryShow", "openFile"].includes(item.type)),
    false,
  )
  const ordinary = {
    ...prepared,
    id: "ordinary",
    synthetic: false,
    ignored: false,
    text: "Ordinary answer with coincidental metadata",
  }
  assert.equal(provenance(ordinary), undefined)
  assert.equal(isRenderable(ordinary, message), true)
  assert.equal(isRenderable(prepared, message), true)
  const tool = { id: "tool", type: "tool", tool: "read", state: { status: "completed", input: {}, output: "done" } }
  const other = { ...message, id: "other" }
  const coalesced = coalesceToolRows([message, other], (item) => (item.id === message.id ? [prepared, tool] : [tool]))
  assert.equal(coalesced.length, 2)
  assert.equal(coalesced[0].parts, undefined)
  setParts([
    marker("bounded", {
      type: "recall",
      count: 20,
      files: ["<img src=x onerror=bad()>", "javascript:bad()", "a".repeat(500), "four", "five", "hidden-six"],
      items: ["PRIVATE VERBOSE TEXT"],
      captured: Infinity,
      scope: { directory: "/unrelated-current-project" },
    }),
  ])
  await tick()
  assert.equal(cards().length, 1)
  cards()[0].querySelector("button").click()
  await tick()
  assert.equal(cards()[0].querySelectorAll("li").length, 5)
  assert.match(root.textContent, /Token estimate was not recorded/)
  assert.equal(cards()[0].querySelectorAll("img, a").length, 0)
  assert.match(root.textContent, /Showing up to five recorded sources/)
  assert.match(root.textContent, /Preparation or retrieval time was not recorded/)
  assert.doesNotMatch(root.textContent, /hidden-six|PRIVATE|unrelated-current-project/)
  setParts([marker("invalid", { type: "future", count: 1, tokens: 1 })])
  await tick()
  assert.equal(cards().length, 0)
  setParts([prepared])
  await tick()
  assert.equal(cards().length, 1)
  cards()[0].querySelector("button").click()
  await tick()
  assert.match(root.textContent, /recorded-worktree/)
  assert.doesNotMatch(root.textContent, /PRIVATE|unrelated-current-project/)
  assert.equal(
    sent.some((item) => ["memoryOperation", "memoryShow", "openFile"].includes(item.type)),
    false,
  )
  console.log("Memory provenance production transcript assertions passed")
} finally {
  dispose()
  await window.happyDOM.close()
}
