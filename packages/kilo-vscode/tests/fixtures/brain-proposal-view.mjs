import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "proposal-review-dom",
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
      if (!result?.code) throw new Error("Component compilation failed")
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
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const { createComponent, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { BrainProposalView } = await import("../../webview-ui/src/components/settings/BrainProposalView.tsx")
const actions = []
const [proposal, setProposal] = createSignal({
  id: "original-proposal",
  project: "C:/work/raya",
  digest: "a".repeat(64),
  status: "pending",
  capture_enabled: false,
  provenance: "Synthetic reviewed source",
  sources: [{ path: "C:/work/raya/source.md", sha256: "b".repeat(64), kind: "document", event_time: null }],
  changes: [{ path: "Preferences/lights.md", expected: null, before: null, content: "Slow lights." }],
})
const [pending, setPending] = createSignal(false)
const [uncertain, setUncertain] = createSignal(false)
const node = document.createElement("main")
document.body.appendChild(node)
const dispose = render(
  () =>
    createComponent(BrainProposalView, {
      get proposal() {
        return proposal()
      },
      get pending() {
        return pending()
      },
      get uncertain() {
        return uncertain()
      },
      apply: () => actions.push("apply"),
      cancel: () => actions.push("cancel"),
      edit: () => actions.push("edit"),
      refresh: () => actions.push("read"),
    }),
  node,
)
const button = (label) => [...node.querySelectorAll("button")].find((item) => item.textContent.trim() === label)
try {
  await Promise.resolve()
  assert.equal(button("Open full review and apply").disabled, false)
  button("Edit proposed changes").click()
  await Promise.resolve()
  assert.equal(button("Read current outcome").disabled, true)
  setUncertain(true)
  assert.equal(button("Save proposal revision").disabled, true)
  assert.equal(button("Read current outcome").disabled, false)
  button("Read current outcome").click()
  assert.deepEqual(actions, ["read"])
  button("Cancel editing").click()
  assert.equal(button("Open full review and apply").disabled, true)
  assert.equal(button("Discard proposal").disabled, true)
  setPending(true)
  assert.equal(button("Read current outcome").disabled, true)
  setPending(false)
  setUncertain(false)
  setProposal({ ...proposal(), status: "applying" })
  assert.match(node.textContent, /Publication is unresolved/)
  assert.equal(button("Open full review and apply").disabled, true)
  setProposal({ ...proposal(), status: "applied" })
  assert.match(node.textContent, /Changes are published/)
  assert.match(node.textContent, /Search-index freshness is not verified/)
  assert.equal(button("Open full review and apply").disabled, true)
  assert.deepEqual(actions, ["read"])
  console.log("proposal review outcome gate passed")
} finally {
  dispose()
  await window.happyDOM.abort()
}
