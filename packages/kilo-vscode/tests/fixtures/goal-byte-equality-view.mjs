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
const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { GoalCriteriaEditor } = await import("../../webview-ui/src/components/chat/GoalCriteriaEditor.tsx")
const check = {
  kind: "byte-equality",
  source: { path: "C:/work/input.txt", canonical: "C:/work/input.txt", sha256: "a".repeat(64), bytes: 48 },
  target: { path: "C:/work/result.txt", canonical: "C:/work/result.txt" },
}
const [value, setValue] = createSignal([
  { id: "bytes", description: "Exact copy", verification: "Read both", review: true, check },
])
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(GoalCriteriaEditor, {
      get value() {
        return value()
      },
      onChange: setValue,
    }),
  root,
)
assert(root.querySelector('[aria-label="Saved byte-equality binding"]'))
assert(root.textContent.includes("Source bytes: 48"))
assert(root.textContent.includes(check.source.sha256))
assert(!root.textContent.includes("Require an exact command result"))
const area = root.querySelector('[data-criterion="bytes"]')
area.value = "Revised description"
area.dispatchEvent(new Event("input", { bubbles: true }))
assert.equal(value()[0].description, "Revised description")
assert.deepEqual(value()[0].check, check)
const review = root.querySelectorAll('input[type="checkbox"]')[1]
review.checked = false
review.dispatchEvent(new Event("change", { bubbles: true }))
assert.equal(value()[0].review, false)
assert.deepEqual(value()[0].check, check)
setValue([
  {
    id: "command",
    description: "Command",
    verification: "Run",
    check: { kind: "command", command: "bun test", directory: "C:/work" },
  },
])
await Promise.resolve()
assert(root.textContent.includes("Require an exact command result"))
assert(!root.querySelector('[aria-label="Saved byte-equality binding"]'))
dispose()
window.happyDOM.abort()
console.log("mounted equality preserved; command editor retained")
