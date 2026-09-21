import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-assignment-dom",
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
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLHeadElement",
  "MutationObserver",
  "Event",
  "MouseEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
globalThis.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => ({}), setState: () => undefined })

const { createComponent, onMount } = await import("solid-js")
const { render } = await import("solid-js/web")
const { DialogProvider, useDialog } = await import("@kilocode/kilo-ui/context/dialog")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { OrganizationAssignment } = await import("../../webview-ui/src/components/routines/OrganizationAssignment.tsx")
const root = document.createElement("div")
const chosen = []
const plans = []
document.body.append(root)
const worker = "11111111-2222-4333-8444-555555555555"
const item = {
  version: 1,
  id: `org_${"a".repeat(32)}`,
  name: "Acceptance Team",
  revision: 1,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  members: [{ agentID: worker, role: "Persistence verifier", position: 0 }],
  delegations: [],
}
function Fixture() {
  const dialog = useDialog()
  onMount(() =>
    dialog.show(() =>
      createComponent(OrganizationAssignment, {
        item,
        agents: [{ id: worker, name: "Persistence Verifier", enabled: true }],
        onChoose: (id) => chosen.push(id),
        onPlan: (text) => plans.push(text),
        onAssigned: () => undefined,
      }),
    ),
  )
  return null
}
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(DialogProvider, {
          get children() {
            return createComponent(Fixture, {})
          },
        })
      },
    }),
  root,
)

try {
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(document.body.textContent, /Persistence Verifier is the only active worker/)
  assert.match(document.body.textContent, /add another worker and choose a delegation direction/)
  const open = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Open worker chat")
  assert.ok(open)
  open.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(chosen, [worker])
} finally {
  dispose()
  window.close()
}
