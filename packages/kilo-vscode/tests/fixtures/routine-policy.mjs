import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-policy-dom",
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
  "PointerEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { SchedulePolicy } = await import("../../webview-ui/src/components/routines/SchedulePolicy.tsx")
const root = document.createElement("div")
document.body.append(root)
const [value, setValue] = createSignal({})
const changes = []
const [disabled, setDisabled] = createSignal(false)
const dispose = render(
  () =>
    createComponent(SchedulePolicy, {
      get value() {
        return value()
      },
      get disabled() {
        return disabled()
      },
      onChange(next) {
        changes.push(next)
        setValue(next)
      },
    }),
  root,
)
const choose = async (index, label) => {
  const trigger = root.querySelectorAll('[data-slot="select-select-trigger"]')[index]
  assert.ok(trigger)
  trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  await new Promise((resolve) => setImmediate(resolve))
  const content = document.getElementById(trigger.getAttribute("aria-controls"))
  assert.ok(content, "The selected control owns its popup")
  const option = [...content.querySelectorAll('[role="option"]')].find((item) => item.textContent.trim() === label)
  assert.ok(option, `Missing policy choice: ${label}`)
  option.click()
  await new Promise((resolve) => setImmediate(resolve))
}
try {
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(value(), {})
  assert.equal(changes.length, 0, "Mount must not rewrite unset legacy policy")
  assert.deepEqual(
    [...root.querySelectorAll('[data-slot="select-select-trigger-value"]')].map((item) => item.textContent),
    ["Keep existing behavior", "Keep existing behavior"],
  )
  await choose(0, "Keep one pending run")
  assert.deepEqual(value(), { overlap: "queue" })
  assert.match(root.textContent, /at most one pending scheduled run/)
  assert.match(root.textContent, /Runs never overlap/)
  await choose(1, "Catch up one eligible occurrence")
  assert.deepEqual(value(), { overlap: "queue", missed: "latest" })
  assert.match(root.textContent, /at most one eligible missed occurrence/)
  assert.match(root.textContent, /older times are not replayed/)
  await choose(0, "Skip this occurrence")
  await choose(1, "Skip missed times")
  assert.deepEqual(value(), { overlap: "skip", missed: "skip" })
  await choose(0, "Keep existing behavior")
  assert.deepEqual(value(), { missed: "skip" })
  await choose(1, "Keep existing behavior")
  assert.deepEqual(value(), {})
  assert.equal(changes.length, 6)
  setDisabled(true)
  assert.ok([...root.querySelectorAll('[data-slot="select-select-trigger"]')].every((item) => item.disabled))
} finally {
  dispose()
  root.remove()
  await window.happyDOM.close()
}
