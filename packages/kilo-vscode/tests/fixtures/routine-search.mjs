import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-search-dom",
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
  "Event",
  "KeyboardEvent",
])
  globalThis[name] = window[name]
globalThis.window = window

const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { ConversationSearch } = await import("../../webview-ui/src/components/routines/ConversationSearch.tsx")
const root = document.createElement("div")
document.body.append(root)
const [agent, setAgent] = createSignal("books")
const calls = []
const dispose = render(
  () =>
    createComponent(ConversationSearch, {
      get agentID() {
        return agent()
      },
      name: "Books",
      onSearch: (query) => calls.push(query),
    }),
  root,
)

try {
  const input = root.querySelector("input[type='search']")
  assert.ok(input)
  assert.equal(input.maxLength, 200)
  assert.equal(input.getAttribute("aria-label"), "Search messages with Books")

  input.value = "  revenue  "
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  input.value = "travel"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(calls, ["travel"])

  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(calls, ["travel", ""])
  assert.equal(input.value, "")

  input.value = "pending"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.match(root.textContent, /Clear/)
  setAgent("legal")
  await Promise.resolve()
  assert.equal(input.value, "")
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(calls, ["travel", ""])

  input.value = "receipt"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  const clear = [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === "Clear")
  assert.ok(clear)
  clear.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(calls, ["travel", "", ""])
  console.log("routine-search: debounce, reset, escape, and clear assertions passed")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
