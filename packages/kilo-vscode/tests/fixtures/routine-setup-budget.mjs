import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-setup-dom",
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
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { default: RoutineSetup } = await import("../../webview-ui/src/components/routines/RoutineSetup.tsx")
const root = document.createElement("div")
document.body.append(root)
const [step, setStep] = createSignal("job")
const [budget, setBudget] = createSignal("")
const props = {
  get step() {
    return step()
  },
  name: "Friday accounts",
  job: "Review Friday accounts and report anything unusual.",
  draft: { mode: "manual" },
  output: {
    destination: "conversation",
    description: "A concise accounting report",
    criteria: [{ id: "findings", description: "List findings", verification: "Check each finding" }],
  },
  role: "Accountant",
  access: "Read and notify",
  dir: "C:/work/reports",
  get budget() {
    return budget()
  },
  saving: false,
  onStep: setStep,
  onName: () => {},
  onJob: () => {},
  onDraft: () => {},
  onBudget: setBudget,
}
const dispose = render(() => createComponent(RoutineSetup, props), root)
const button = (text) => {
  const found = [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === text)
  assert.ok(found, `Missing button: ${text}`)
  return found
}

try {
  button("Continue").click()
  assert.equal(step(), "schedule")
  button("Continue").click()
  assert.equal(step(), "budget")
  assert.match(root.textContent, /Should one run have a cost limit/)
  const input = root.querySelector('input[type="number"]')
  assert.ok(input)
  input.value = "0"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.equal(button("Review choices").disabled, true)
  input.value = "12.5"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  assert.equal(button("Review choices").disabled, false)
  button("Review choices").click()
  assert.equal(step(), "review")
  assert.match(root.textContent, /\$12\.5 per run/)
  assert.match(root.textContent, /Nothing is saved until you assign it/)
} finally {
  dispose()
  window.close()
}
